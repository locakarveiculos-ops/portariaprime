package br.com.portariaprime.kiosk

import android.app.Application
import android.app.job.JobParameters
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject

class KioskApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Crash do processo: o Android reinicia a Activity HOME; aqui só reaplicamos a política local.
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try { Store(this).queueEvent("agent.restart", JSONObject().put("detail", e.javaClass.simpleName)) } catch (_: Exception) {}
            previous?.uncaughtException(t, e)
        }
    }
}

/**
 * Boot: encerra manutenção (o relógio desde o boot zerou), reaplica a política e agenda o sync.
 * A volta à tela é garantida pelo launcher persistente (HOME), não por abrir Activity daqui —
 * Android 10+ restringe início de Activity em segundo plano.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_LOCKED_BOOT_COMPLETED) return   // armazenamento ainda cifrado; espera o BOOT_COMPLETED
        val agent = Agent.get(context)
        agent.applyLocal()
        agent.event(if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) "agent.restart" else "boot", JSONObject().put("detail", intent.action?.substringAfterLast('.')))
        agent.schedule()
    }
}

class MaintenanceAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val a = Agent.get(context)
        if (!a.maintenanceActive()) a.endMaintenanceLocal("expired")
    }
}

class SyncJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Agent.get(this).syncAsync { jobFinished(params, false) }
        return true
    }
    override fun onStopJob(params: JobParameters) = true
}
