package br.com.portariaprime.kiosk.admin

import android.app.admin.DevicePolicyManager
import android.app.admin.SystemUpdatePolicy
import android.content.ComponentName
import android.content.Context
import android.content.IntentFilter
import android.content.Intent
import android.os.BatteryManager
import android.os.Build
import android.os.UserManager
import android.provider.Settings
import br.com.portariaprime.kiosk.KioskActivity
import br.com.portariaprime.kiosk.core.Policy

/**
 * Aplica a política via DevicePolicyManager (somente APIs oficiais do Device Owner).
 * Cada passo é independente: falha em um item vira "não aplicado" no relatório, sem abortar o resto.
 * Câmera nunca é tocada; USB/Bluetooth só se a política pedir (leitores HID continuam funcionando).
 */
class PolicyEnforcer(private val ctx: Context) {
    private val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
    private val admin = KioskAdminReceiver.component(ctx)
    private val self = ctx.packageName

    val isDeviceOwner get() = dpm.isDeviceOwnerApp(self)

    private val restrictionMap = mapOf(
        "no_install_apps" to UserManager.DISALLOW_INSTALL_APPS,
        "no_uninstall_apps" to UserManager.DISALLOW_UNINSTALL_APPS,
        "no_unknown_sources" to UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES,
        "no_add_user" to UserManager.DISALLOW_ADD_USER,
        "no_modify_accounts" to UserManager.DISALLOW_MODIFY_ACCOUNTS,
        "no_debugging" to UserManager.DISALLOW_DEBUGGING_FEATURES,
        "no_safe_boot" to UserManager.DISALLOW_SAFE_BOOT,
        "no_factory_reset" to UserManager.DISALLOW_FACTORY_RESET,
        "no_config_wifi" to UserManager.DISALLOW_CONFIG_WIFI,
        "no_usb_file_transfer" to UserManager.DISALLOW_USB_FILE_TRANSFER,
        "no_config_bluetooth" to UserManager.DISALLOW_CONFIG_BLUETOOTH,
    )

    companion object {
        /** Restrições que a manutenção temporária mantém (saída definitiva só por desprovisionamento). */
        val KEEP_IN_MAINTENANCE = setOf("no_factory_reset", "no_add_user", "no_modify_accounts", "no_safe_boot")
    }

    /** Aplica e devolve a lista do que falhou (vazia = conforme). */
    fun apply(p: Policy, maintenance: Boolean): Set<String> {
        if (!isDeviceOwner) return setOf("lock_task")
        val failed = mutableSetOf<String>()
        fun step(key: String, block: () -> Unit) = try { block() } catch (_: Exception) { failed += key }

        // Lock Task: Single-App só o próprio pacote; Multi-App acrescenta apps aprovados que existem.
        step("lock_task") {
            val pkgs = if (p.singleApp || maintenance) arrayOf(self) else (listOf(self) + p.apps.filter { installed(it) }).distinct().toTypedArray()
            dpm.setLockTaskPackages(admin, if (maintenance) emptyArray() else pkgs)
            if (Build.VERSION.SDK_INT >= 28) dpm.setLockTaskFeatures(admin, features(p))
        }
        // Launcher persistente: HOME sempre é o quiosque (recuperação após reboot sem depender de BOOT_COMPLETED).
        step("lock_task") {
            val filter = IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) }
            if (maintenance) dpm.clearPackagePersistentPreferredActivities(admin, self)
            else dpm.addPersistentPreferredActivity(admin, filter, ComponentName(ctx, KioskActivity::class.java))
        }
        // Restrições: a manutenção libera o uso normal do aparelho (Configurações, Wi-Fi, apps), mas NÃO
        // libera o que tornaria a saída definitiva: restauração de fábrica, usuários/contas extras e modo de
        // segurança. Esses só caem no desprovisionamento supervisionado (releaseOwnership), nunca na manutenção.
        for ((key, r) in restrictionMap) step(key) {
            val keepInMaintenance = key in KEEP_IN_MAINTENANCE
            // Variante de laboratório nunca desliga o ADB: é por ele que o Device Owner sai sem restauração.
            val wanted = key in p.restrictions && (!maintenance || keepInMaintenance) &&
                !(key == "no_debugging" && br.com.portariaprime.kiosk.BuildConfig.LAB_BUILD)
            if (wanted) dpm.addUserRestriction(admin, r) else dpm.clearUserRestriction(admin, r)
        }
        step("no_screen_capture") { dpm.setScreenCaptureDisabled(admin, !maintenance && "no_screen_capture" in p.restrictions) }
        step("status_bar") { dpm.setStatusBarDisabled(admin, !maintenance && p.statusBarDisabled) }
        step("keyguard") {
            // Sem tela de bloqueio no quiosque só se a política não pedir keyguard (aparelho fica em área controlada).
            dpm.setKeyguardDisabled(admin, !maintenance && "keyguard" !in p.lockTaskFeatures)
        }
        step("system_update") {
            dpm.setSystemUpdatePolicy(admin, p.updateWindow?.let { (a, b) -> SystemUpdatePolicy.createWindowedInstallPolicy(a, b) }
                ?: SystemUpdatePolicy.createAutomaticInstallPolicy())
        }
        step("stay_on") {
            val v = if (!maintenance && p.stayOnPlugged) (BatteryManager.BATTERY_PLUGGED_AC or BatteryManager.BATTERY_PLUGGED_USB or BatteryManager.BATTERY_PLUGGED_WIRELESS) else 0
            dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, v.toString())
        }
        if (Build.VERSION.SDK_INT >= 28) p.brightness?.let { b -> step("brightness") {
            dpm.setSystemSetting(admin, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL.toString())
            dpm.setSystemSetting(admin, Settings.System.SCREEN_BRIGHTNESS, b.toString())
        } }
        // Câmera: garante que nenhuma política anterior a deixou desligada.
        step("camera") { dpm.setCameraDisabled(admin, false) }
        // Permissão de câmera concedida ao próprio app (o operador ainda aciona a câmera na tela).
        step("camera") {
            dpm.setPermissionGrantState(admin, self, android.Manifest.permission.CAMERA, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
        }
        return failed - "camera" + (if ("camera" in failed) setOf("camera_grant") else emptySet())
    }

    @android.annotation.TargetApi(28)
    private fun features(p: Policy): Int {
        var f = DevicePolicyManager.LOCK_TASK_FEATURE_NONE
        if ("system_info" in p.lockTaskFeatures) f = f or DevicePolicyManager.LOCK_TASK_FEATURE_SYSTEM_INFO
        if ("global_actions" in p.lockTaskFeatures) f = f or DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS
        if ("keyguard" in p.lockTaskFeatures) f = f or DevicePolicyManager.LOCK_TASK_FEATURE_KEYGUARD
        if (!p.singleApp) {
            if ("home" in p.lockTaskFeatures) f = f or DevicePolicyManager.LOCK_TASK_FEATURE_HOME
            if ("overview" in p.lockTaskFeatures) f = f or DevicePolicyManager.LOCK_TASK_FEATURE_OVERVIEW
            if ("notifications" in p.lockTaskFeatures) f = f or DevicePolicyManager.LOCK_TASK_FEATURE_NOTIFICATIONS
        }
        return f
    }

    fun installed(pkg: String): Boolean = try { ctx.packageManager.getPackageInfo(pkg, 0); true } catch (_: Exception) { false }

    fun versionCode(pkg: String): Long? = try {
        val i = ctx.packageManager.getPackageInfo(pkg, 0)
        if (Build.VERSION.SDK_INT >= 28) i.longVersionCode else @Suppress("DEPRECATION") i.versionCode.toLong()
    } catch (_: Exception) { null }

    fun reboot(): Boolean = if (isDeviceOwner) { dpm.reboot(admin); true } else false

    /**
     * Desativação supervisionada: remove restrições, Lock Task e launcher persistente e abre mão do Device Owner.
     * Não apaga dados nem restaura de fábrica. Devolve null só se o Android confirmar a saída; senão, o motivo.
     * Já fora do gerenciamento (repetição após queda de conexão) também é sucesso.
     */
    fun releaseOwnership(): String? {
        if (!isDeviceOwner) return null
        apply(Policy.fallback().copy(restrictions = emptySet(), statusBarDisabled = false), maintenance = true)
        try { dpm.setLockTaskPackages(admin, emptyArray()) } catch (_: Exception) {}
        try { dpm.setKeyguardDisabled(admin, false) } catch (_: Exception) {}
        try { dpm.setSystemUpdatePolicy(admin, null) } catch (_: Exception) {}
        try { dpm.setPermissionGrantState(admin, self, android.Manifest.permission.CAMERA, DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT) } catch (_: Exception) {}
        return try {
            @Suppress("DEPRECATION") dpm.clearDeviceOwnerApp(self)
            // Sem admin ativo o app fica desinstalável pelo caminho comum (Configurações → Apps).
            if (dpm.isAdminActive(admin)) dpm.removeActiveAdmin(admin)
            if (isDeviceOwner) "O Android manteve o Device Owner." else null
        } catch (e: Exception) { "O Android recusou liberar o Device Owner: ${e.message}".take(200) }
    }
}
