package br.com.portariaprime.kiosk

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import br.com.portariaprime.kiosk.admin.PolicyEnforcer
import br.com.portariaprime.kiosk.core.Backoff
import br.com.portariaprime.kiosk.core.MaintenanceClock
import br.com.portariaprime.kiosk.core.MaintenanceState
import br.com.portariaprime.kiosk.core.Policy
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Agente: mantém a última política válida aplicada (também offline), busca comandos autenticados,
 * confirma cada etapa (recebido/aplicando/aplicado/falhou) e controla a manutenção com prazo local.
 * Nenhum comando arbitrário: só as ações enumeradas abaixo.
 */
class Agent private constructor(private val ctx: Context) {
    val store = Store(ctx)
    val enforcer = PolicyEnforcer(ctx)
    private val api = Api(BuildConfig.APP_ORIGIN, store, ctx)
    private val io = Executors.newSingleThreadExecutor()
    @Volatile var listener: (() -> Unit)? = null

    fun maintenanceActive() = MaintenanceClock.isActive(store.maintenance(), SystemClock.elapsedRealtime(), store.bootCount())
    fun maintenanceRemainingMs() = MaintenanceClock.remainingMs(store.maintenance(), SystemClock.elapsedRealtime(), store.bootCount())

    /** Reaplica a última política válida (boot, crash, fim de manutenção). Sem rede. */
    @Synchronized fun applyLocal(): Set<String> {
        val m = store.maintenance()
        if (m?.active == true && !maintenanceActive()) endMaintenanceLocal(if (m.bootCount != store.bootCount()) "reboot" else "expired")
        val failed = enforcer.apply(store.policy(), maintenanceActive())
        store.failedRestrictions = failed
        if (!enforcer.isDeviceOwner) store.lastError = "Aplicativo sem Device Owner: quiosque não protegido."
        return failed
    }

    fun syncAsync(after: (() -> Unit)? = null) = io.execute { try { sync() } catch (_: Exception) {} ; after?.invoke(); listener?.invoke() }

    fun enrollAsync(token: String, done: (String?) -> Unit) = io.execute {
        done(try {
            // Código inválido/expirado não pode apagar a inscrição atual: a chave nova é gerada em alias
            // temporário e só substitui a antiga (e zera contador/credencial local) depois do aceite do servidor.
            val pub = DeviceIdentity.candidate(ctx)
            val info = JSONObject().put("managed", enforcer.isDeviceOwner).put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
                .put("release", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT).put("agentVersion", BuildConfig.VERSION_NAME)
            val r = api.enroll(token, pub, info)
            DeviceIdentity.commit(ctx)
            store.resetEnrollment()
            store.deviceId = r.getString("deviceId"); store.tenantSlug = r.getString("tenantSlug"); store.deviceName = r.optString("deviceName")
            ctx.getSharedPreferences("kiosk", Context.MODE_PRIVATE).edit().remove("pending_token").commit()
            sync(); null
        } catch (e: Api.HttpException) { e.message } catch (e: Exception) { "Sem conexão com o servidor. Verifique a internet e tente de novo." })
        listener?.invoke()
    }

    @Synchronized fun sync() {
        if (store.deviceId == null || store.revoked) return
        try {
            flushEvents()   // dentro do try: sem rede não pode abortar antes do reagendamento
            val r = api.signed("/api/totem/kiosk-sync", JSONObject().put("report", report()))
            store.failures = 0; store.lastSyncOkWall = System.currentTimeMillis(); store.lastError = null
            r.optJSONObject("device")?.let { d -> store.tenantSlug = d.optString("tenant_slug", store.tenantSlug); store.deviceName = d.optString("name") }
            r.optJSONObject("policy")?.let { p ->
                try {
                    val parsed = Policy.parse(p.getString("version_id"), p.getJSONObject("config"))
                    store.savePolicy(parsed.versionId, p.getJSONObject("config"))
                    store.appsMeta = r.optJSONArray("apps_meta") ?: JSONArray()
                    val failed = applyLocal()
                    store.appliedVersion = if ("lock_task" in failed) null else parsed.versionId
                } catch (e: Exception) { store.lastError = "Política recusada pelo aparelho: ${e.message}"; event("policy.failed", JSONObject().put("detail", e.message)) }
            }
            r.optString("shift_nonce").takeIf { Regex("^[0-9a-f]{64}$").matches(it) }?.let { store.shiftNonce = it }
            r.optJSONObject("recovery")?.let { rec -> store.saveRecovery(rec.getInt("version"), rec.getJSONArray("codes")) }
            r.optJSONArray("used_recovery")?.let { a -> for (i in 0 until a.length()) store.markRecoveryUsed(a.getInt(i)) }
            val cmds = r.optJSONArray("commands") ?: JSONArray()
            for (i in 0 until cmds.length()) handle(cmds.getJSONObject(i), r.optString("server_time"))
        } catch (e: Api.HttpException) {
            store.failures = store.failures + 1
            if (e.status == 401 && e.message?.contains("revogada") == true) store.revoked = true   // mantém a última política; recuperação por código continua
            store.lastError = e.message
        } catch (e: Exception) {
            store.failures = store.failures + 1
        } finally { schedule() }
    }

    private fun report(): JSONObject {
        val bm = ctx.getSystemService(BatteryManager::class.java)
        val apps = JSONArray()
        val meta = store.appsMeta
        for (i in 0 until meta.length()) {
            val pkg = meta.getJSONObject(i).getString("package_name")
            enforcer.versionCode(pkg)?.let { apps.put(JSONObject().put("package_name", pkg).put("version_code", it)) }
        }
        return JSONObject().put("managed", enforcer.isDeviceOwner).put("applied_version_id", store.appliedVersion ?: JSONObject.NULL)
            .put("battery_pct", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)).put("charging", bm.isCharging)
            .put("agent_version", BuildConfig.VERSION_NAME).put("sdk", Build.VERSION.SDK_INT.toString()).put("release", Build.VERSION.RELEASE)
            .put("failed_restrictions", JSONArray(store.failedRestrictions.toList())).put("apps", apps)
            .put("maintenance", maintenanceActive()).put("lock_task", enforcer.isDeviceOwner && !maintenanceActive())
            .put("recovery_version", store.recoveryVersion()).put("network", network())
            .put("capabilities", JSONObject().put("lock_task_features", Build.VERSION.SDK_INT >= 28).put("brightness", Build.VERSION.SDK_INT >= 28).put("wpa3", Build.VERSION.SDK_INT >= 30))
            .put("last_error", store.lastError ?: "")
    }

    private fun network(): String {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val c = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "sem rede"
        return when { c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"; c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "celular"; else -> "outra" }
    }

    private fun ack(id: String, status: String, detail: String? = null) =
        api.signed("/api/totem/kiosk-ack", JSONObject().put("commandId", id).put("status", status).put("detail", detail ?: JSONObject.NULL))

    private fun handle(c: JSONObject, serverTime: String) {
        val id = c.getString("id"); val seq = c.getLong("seq")
        if (store.commandDone(id)) { ack(id, "applied", "Já aplicado."); return }
        // Validade: o servidor só entrega não expirados; ordem por seq evita reaplicar comando antigo.
        if (seq <= store.lastCommandSeq && c.getString("status") == "pending") { ack(id, "failed", "Fora de ordem."); return }
        if (c.optString("expires_at") <= serverTime) return
        ack(id, "received")
        val p = c.optJSONObject("params") ?: JSONObject()
        val result: Pair<String, String?> = try {
            when (c.getString("action")) {
                "sync_policy" -> "applied" to "Política ${store.appliedVersion ?: "não aplicada"}."
                "start_maintenance" -> {
                    ack(id, "applying")
                    startMaintenance(p.getInt("minutes"), p.optString("session_id"), p.optString("scope", "settings"))
                    "applied" to "Manutenção por ${p.getInt("minutes")} min."
                }
                "end_maintenance" -> { endMaintenanceLocal("manual"); "applied" to "Quiosque reaplicado." }
                "reboot" -> {
                    store.markCommandDone(id); store.lastCommandSeq = seq
                    ack(id, "applied", "Reinício iniciado.")
                    if (!enforcer.reboot()) "failed" to "Reinício não suportado neste aparelho/modo." else return
                }
                "wifi_apply" -> { ack(id, "applying"); wifiTwoStep(p) }
                "deactivate" -> {
                    ack(id, "applying")
                    store.markCommandDone(id); store.lastCommandSeq = seq
                    ack(id, "applied", "Restrições removidas; Device Owner liberado.")
                    enforcer.releaseOwnership()
                    store.revoked = true
                    return
                }
                else -> "failed" to "Ação desconhecida."
            }
        } catch (e: Exception) { "failed" to (e.message ?: "erro").take(200) }
        store.markCommandDone(id); store.lastCommandSeq = seq
        ack(id, result.first, result.second)
    }

    // ---- Manutenção ------------------------------------------------------------------------------

    fun startMaintenance(minutes: Int, sessionId: String?, scope: String) {
        val p = store.policy()
        store.saveMaintenance(MaintenanceClock.start(SystemClock.elapsedRealtime(), store.bootCount(), minutes.coerceAtMost(p.maintenanceMaxMinutes),
            p.maintenanceMaxMinutes, sessionId, scope))
        applyLocal()
        alarm(minutes * 60_000L)
        listener?.invoke()
    }

    fun endMaintenanceLocal(reason: String) {
        val was = store.maintenance()?.active == true
        store.saveMaintenance(null)
        enforcer.apply(store.policy(), false)
        if (was) { event("maintenance.end", JSONObject().put("reason", reason)); syncAsync() }
        ctx.startActivity(Intent(ctx, KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        listener?.invoke()
    }

    private fun alarm(inMs: Long) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val pi = PendingIntent.getBroadcast(ctx, 7, Intent(ctx, MaintenanceAlarmReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val at = SystemClock.elapsedRealtime() + inMs
        // Exato quando permitido (Android 12+ exige a permissão SCHEDULE_EXACT_ALARM); senão inexato (atraso de alguns minutos).
        if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)
        else am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)
    }

    // ---- Wi-Fi em duas etapas ---------------------------------------------------------------------

    @Suppress("DEPRECATION")
    private fun wifiTwoStep(p: JSONObject): Pair<String, String?> {
        val wm = ctx.getSystemService(WifiManager::class.java)
        val previous = wm.connectionInfo?.networkId ?: -1
        val conf = WifiConfiguration().apply {
            SSID = "\"${p.getString("ssid")}\""
            hiddenSSID = p.optBoolean("hidden")
            when (p.getString("security")) {
                "open" -> allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
                "wpa3" -> if (Build.VERSION.SDK_INT >= 30) { setSecurityParams(WifiConfiguration.SECURITY_TYPE_SAE); preSharedKey = "\"${p.getString("password")}\"" }
                          else throw IllegalStateException("WPA3 exige Android 11+.")
                else -> preSharedKey = "\"${p.getString("password")}\""
            }
        }
        val newId = wm.addNetwork(conf)
        if (newId < 0) return "failed" to "O Android recusou a nova rede (sem permissão de Device Owner ou dados inválidos)."
        // Etapa 1: conecta na nova e testa o backend. Etapa 2: só então remove a anterior.
        wm.enableNetwork(newId, true)
        var ok = false
        for (i in 0 until 12) {
            SystemClock.sleep(5_000)
            if (wm.connectionInfo?.networkId == newId) {
                ok = try { api.signed("/api/totem/kiosk-event", JSONObject().put("event", "wifi.applied").put("data", JSONObject().put("detail", "teste"))); true } catch (_: Exception) { false }
                if (ok) break
            }
        }
        return if (ok) {
            if (previous >= 0 && previous != newId) wm.removeNetwork(previous)
            "applied" to "Nova rede conectada e testada; anterior removida."
        } else {
            wm.removeNetwork(newId)
            if (previous >= 0) wm.enableNetwork(previous, true)
            event("wifi.rollback", JSONObject().put("detail", "sem acesso ao servidor pela nova rede"))
            "failed" to "Sem acesso ao servidor pela nova rede; rede anterior restaurada."
        }
    }

    // ---- Eventos e agendamento -------------------------------------------------------------------

    fun event(name: String, data: JSONObject) { store.queueEvent(name, data); io.execute { try { flushEvents() } catch (_: Exception) {} } }

    @Synchronized private fun flushEvents() {
        if (store.deviceId == null || store.revoked) return
        val a = store.pendingEvents()
        var sent = 0
        try {
            for (i in 0 until a.length()) {
                val e = a.getJSONObject(i)
                api.signed("/api/totem/kiosk-event", JSONObject().put("event", e.getString("event")).put("data", e.getJSONObject("data")))
                sent++
            }
        } catch (e: Api.HttpException) { if (e.status in 400..499 && e.status != 401 && e.status != 429) sent++ }  // descarta inválido
        catch (_: java.io.IOException) { /* sem rede: mantém na fila e tenta no próximo sync */ }
        finally { store.dropEvents(sent) }
    }

    fun schedule() {
        val js = ctx.getSystemService(JobScheduler::class.java)
        val delay = Backoff.nextDelaySeconds(store.policy().syncIntervalSeconds, store.failures, Math.random() * 0.2) * 1000
        js.schedule(JobInfo.Builder(1, ComponentName(ctx, SyncJobService::class.java))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setMinimumLatency(delay).setOverrideDeadline(delay * 2).setPersisted(true).build())
    }

    companion object {
        @android.annotation.SuppressLint("StaticFieldLeak")  // guarda só o applicationContext
        @Volatile private var instance: Agent? = null
        fun get(ctx: Context) = instance ?: synchronized(this) { instance ?: Agent(ctx.applicationContext).also { instance = it } }
    }
}
