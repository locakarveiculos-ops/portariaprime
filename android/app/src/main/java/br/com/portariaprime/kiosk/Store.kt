package br.com.portariaprime.kiosk

import android.content.Context
import android.provider.Settings
import br.com.portariaprime.kiosk.core.Attempts
import br.com.portariaprime.kiosk.core.MaintenanceState
import br.com.portariaprime.kiosk.core.Policy
import br.com.portariaprime.kiosk.core.StoredCode
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Estado local em armazenamento protegido por credencial do app (sem backup, ver data_extraction_rules).
 * Não guarda segredos em texto: a chave privada fica no Keystore; códigos de recuperação só como hash.
 */
class Store(ctx: Context) {
    private val app = ctx.applicationContext
    private val p = app.getSharedPreferences("kiosk", Context.MODE_PRIVATE)

    val agentId: String get() = p.getString("agent_id", null) ?: UUID.randomUUID().toString().also { p.edit().putString("agent_id", it).apply() }
    var deviceId: String?
        get() = p.getString("device_id", null)
        set(v) { p.edit().putString("device_id", v).apply() }
    var tenantSlug: String?
        get() = p.getString("tenant_slug", null)
        set(v) { p.edit().putString("tenant_slug", v).apply() }
    var deviceName: String?
        get() = p.getString("device_name", null)
        set(v) { p.edit().putString("device_name", v).apply() }
    var revoked: Boolean
        get() = p.getBoolean("revoked", false)
        set(v) { p.edit().putBoolean("revoked", v).apply() }
    var lastSyncOkWall: Long
        get() = p.getLong("last_sync_ok", 0)
        set(v) { p.edit().putLong("last_sync_ok", v).apply() }
    var failures: Int
        get() = p.getInt("failures", 0)
        set(v) { p.edit().putInt("failures", v).apply() }
    var lastError: String?
        get() = p.getString("last_error", null)
        set(v) { p.edit().putString("last_error", v?.take(300)).apply() }
    var failedRestrictions: Set<String>
        get() = p.getStringSet("failed_restrictions", emptySet())!!
        set(v) { p.edit().putStringSet("failed_restrictions", v).apply() }

    /** Contador monotônico das requisições assinadas (anti-replay). commit() síncrono: nunca reutiliza. */
    @Synchronized fun nextCounter(): Long {
        val n = p.getLong("counter", 0) + 1
        p.edit().putLong("counter", n).commit()
        return n
    }

    fun resetEnrollment() { p.edit().remove("device_id").remove("counter").remove("policy").remove("policy_version").putBoolean("revoked", false).commit() }

    // Última política válida: continua valendo offline.
    fun savePolicy(versionId: String, config: JSONObject) { p.edit().putString("policy", config.toString()).putString("policy_version", versionId).commit() }
    fun policy(): Policy = try {
        val raw = p.getString("policy", null)
        if (raw == null) Policy.fallback() else Policy.parse(p.getString("policy_version", "")!!, JSONObject(raw))
    } catch (_: Exception) { Policy.fallback() }
    var appliedVersion: String?
        get() = p.getString("applied_version", null)
        set(v) { p.edit().putString("applied_version", v).commit() }

    /** Nonce de turno (só identifica o aparelho para auditoria de turno; não concede acesso). */
    var shiftNonce: String?
        get() = p.getString("shift_nonce", null)
        set(v) { p.edit().putString("shift_nonce", v).apply() }

    var appsMeta: JSONArray
        get() = JSONArray(p.getString("apps_meta", "[]"))
        set(v) { p.edit().putString("apps_meta", v.toString()).apply() }

    // Comandos já concluídos (idempotência local).
    fun commandDone(id: String) = p.getStringSet("done_cmds", emptySet())!!.contains(id)
    fun markCommandDone(id: String) {
        val s = p.getStringSet("done_cmds", emptySet())!!.toMutableList().apply { add(id) }.takeLast(100).toSet()
        p.edit().putStringSet("done_cmds", s).commit()
    }
    var lastCommandSeq: Long
        get() = p.getLong("last_seq", 0)
        set(v) { p.edit().putLong("last_seq", v).commit() }

    fun maintenance(): MaintenanceState? = p.getString("maintenance", null)?.let {
        val o = JSONObject(it)
        MaintenanceState(o.getBoolean("active"), o.getInt("boot"), o.getLong("deadline"), o.optString("session").ifEmpty { null }, o.getString("scope"))
    }
    fun saveMaintenance(m: MaintenanceState?) {
        p.edit().putString("maintenance", m?.let { JSONObject().put("active", it.active).put("boot", it.bootCount).put("deadline", it.deadlineElapsedMs)
            .put("session", it.sessionId ?: "").put("scope", it.scope).toString() }).commit()
    }

    fun recoveryVersion(): Int = p.getInt("recovery_version", -1)
    fun recoveryCodes(): List<StoredCode> = JSONArray(p.getString("recovery_codes", "[]")).let { a ->
        (0 until a.length()).map { a.getJSONObject(it) }.map { StoredCode(it.getInt("idx"), it.getString("salt"), it.getString("hash"), it.getInt("iterations"), it.optBoolean("used")) }
    }
    fun saveRecovery(version: Int, codes: JSONArray) { p.edit().putInt("recovery_version", version).putString("recovery_codes", codes.toString()).commit() }
    fun markRecoveryUsed(idx: Int) {
        val a = JSONArray(p.getString("recovery_codes", "[]"))
        for (i in 0 until a.length()) if (a.getJSONObject(i).getInt("idx") == idx) a.getJSONObject(i).put("used", true)
        p.edit().putString("recovery_codes", a.toString()).commit()
    }

    fun attempts(): Attempts = Attempts(p.getInt("att_fail", 0), p.getLong("att_lock", 0), p.getInt("att_boot", 0))
    fun saveAttempts(a: Attempts) { p.edit().putInt("att_fail", a.failures).putLong("att_lock", a.lockUntilElapsed).putInt("att_boot", a.bootCount).commit() }

    // Eventos locais pendentes de envio (offline): fila curta, sem dados pessoais.
    fun queueEvent(event: String, data: JSONObject) {
        val a = JSONArray(p.getString("events", "[]"))
        a.put(JSONObject().put("event", event).put("data", data))
        val trimmed = JSONArray((maxOf(0, a.length() - 50) until a.length()).map { a.get(it) })
        p.edit().putString("events", trimmed.toString()).commit()
    }
    fun pendingEvents(): JSONArray = JSONArray(p.getString("events", "[]"))
    fun dropEvents(n: Int) {
        val a = JSONArray(p.getString("events", "[]"))
        p.edit().putString("events", JSONArray((n until a.length()).map { a.get(it) }).toString()).commit()
    }

    fun bootCount(): Int = Settings.Global.getInt(app.contentResolver, Settings.Global.BOOT_COUNT, 0)
}
