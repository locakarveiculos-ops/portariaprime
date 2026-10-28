package br.com.portariaprime.kiosk.admin

import android.app.admin.DeviceAdminReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.PersistableBundle
import br.com.portariaprime.kiosk.Store
import br.com.portariaprime.kiosk.Agent

/** Componente DPC (Device Owner). Recebe o fim do provisionamento e o token de inscrição do QR. */
class KioskAdminReceiver : DeviceAdminReceiver() {
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        // Android < 10: o token chega aqui. No 10+ chega em ProvisioningActivity (ADMIN_POLICY_COMPLIANCE).
        @Suppress("DEPRECATION")
        val extras = intent.getParcelableExtra<PersistableBundle>("android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE")
        handleExtras(context, extras)
        Agent.get(context).applyLocal()
        context.startActivity(Intent(context, br.com.portariaprime.kiosk.KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    override fun onEnabled(context: Context, intent: Intent) { Agent.get(context).applyLocal() }

    companion object {
        fun component(ctx: Context) = ComponentName(ctx, KioskAdminReceiver::class.java)

        fun handleExtras(ctx: Context, extras: PersistableBundle?) {
            val token = extras?.getString("pp_enroll_token") ?: return
            // A origem da API é fixa no APK; o valor do QR só é aceito se for idêntico (nunca redireciona).
            if (Regex("^[A-Z0-9]{24}$").matches(token)) ctx.getSharedPreferences("kiosk", Context.MODE_PRIVATE).edit().putString("pending_token", token).commit()
            Store(ctx)
        }
    }
}
