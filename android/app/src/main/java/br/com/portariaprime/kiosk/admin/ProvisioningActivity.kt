package br.com.portariaprime.kiosk.admin

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle

/**
 * Android 10+: o setup pergunta o modo (GET_PROVISIONING_MODE) e depois pede conformidade
 * (ADMIN_POLICY_COMPLIANCE). Respondemos "totalmente gerenciado" — perfil de trabalho não serve a quiosque.
 */
class ProvisioningActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        @Suppress("DEPRECATION")
        val extras = intent.getParcelableExtra<PersistableBundle>(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
        KioskAdminReceiver.handleExtras(this, extras)
        when (intent.action) {
            DevicePolicyManager.ACTION_GET_PROVISIONING_MODE -> {
                val result = Intent()
                if (Build.VERSION.SDK_INT >= 29) result.putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE)
                extras?.let { result.putExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE, it) }
                setResult(RESULT_OK, result)
            }
            else -> setResult(RESULT_OK)
        }
        finish()
    }
}
