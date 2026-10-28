package br.com.portariaprime.kiosk.core

import org.json.JSONObject

/**
 * Política recebida do servidor, revalidada localmente (defesa em profundidade: o banco já valida).
 * Qualquer campo inesperado ou pedido de bloquear a câmera invalida a política inteira, e o agente
 * mantém a última política válida.
 */
data class Policy(
    val versionId: String,
    val mode: String,
    val startPath: String,
    val apps: List<String>,
    val lockTaskFeatures: Set<String>,
    val statusBarDisabled: Boolean,
    val restrictions: Set<String>,
    val keepScreenOn: Boolean,
    val stayOnPlugged: Boolean,
    val orientation: String,
    val brightness: Int?,
    val updateWindow: Pair<Int, Int>?,
    val maintenanceMaxMinutes: Int,
    val syncIntervalSeconds: Int,
) {
    val singleApp get() = mode == "single_app"

    companion object {
        val RESTRICTION_KEYS = setOf(
            "no_install_apps", "no_uninstall_apps", "no_unknown_sources", "no_add_user", "no_modify_accounts", "no_debugging",
            "no_safe_boot", "no_screen_capture", "no_factory_reset", "no_config_wifi", "no_usb_file_transfer", "no_config_bluetooth",
        )
        val FEATURE_KEYS = setOf("system_info", "notifications", "home", "overview", "global_actions", "keyguard")
        private val PACKAGE = Regex("^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$")
        private val KEYS = setOf("mode", "start_path", "apps", "lock_task_features", "status_bar_disabled", "restrictions", "keep_screen_on",
            "stay_on_plugged", "orientation", "brightness", "system_update", "maintenance_max_minutes", "sync_interval_seconds")

        /**
         * Política embutida antes da primeira sincronização: Single-App, nada liberado.
         * Sem "no_debugging" aqui: desligar ADB só por decisão explícita da política do servidor
         * (evita prender um aparelho de laboratório que ainda não falou com o backend).
         */
        fun fallback() = Policy("", "single_app", "portaria", emptyList(), setOf("global_actions"), true,
            setOf("no_add_user", "no_factory_reset", "no_modify_accounts", "no_safe_boot", "no_unknown_sources"),
            true, false, "auto", null, null, 30, 300)

        fun parse(versionId: String, c: JSONObject): Policy {
            c.keys().forEach { require(it in KEYS) { "campo desconhecido: $it" } }
            val mode = c.getString("mode")
            require(mode == "single_app" || mode == "multi_app") { "modo inválido" }
            val start = c.optString("start_path", "portaria")
            require(start in setOf("portaria", "totem-equipe", "painel")) { "tela inicial inválida" }
            val apps = c.optJSONArray("apps")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            require(apps.all { PACKAGE.matches(it) }) { "pacote inválido" }
            require(mode == "multi_app" || apps.isEmpty()) { "single-app com apps" }
            val feats = c.optJSONArray("lock_task_features")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet()
            require(feats.all { it in FEATURE_KEYS }) { "recurso inválido" }
            require(mode == "multi_app" || feats.none { it in setOf("home", "overview", "notifications") }) { "single-app liberando sistema" }
            val restr = c.optJSONArray("restrictions")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet()
            require(restr.none { it.contains("camera") }) { "câmera não pode ser bloqueada" }
            require(restr.all { it in RESTRICTION_KEYS }) { "restrição inválida" }
            val su = c.optJSONObject("system_update")
            val window = if (su?.optString("type") == "windowed") su.getInt("start_min") to su.getInt("end_min") else null
            window?.let { (a, b) -> require(a in 0..1439 && b in 0..1439 && a != b) { "janela inválida" } }
            val maint = c.optInt("maintenance_max_minutes", 30)
            require(maint in 5..240) { "manutenção fora do limite" }
            val sync = c.optInt("sync_interval_seconds", 300)
            require(sync in 60..3600) { "intervalo fora do limite" }
            val orientation = c.optString("orientation", "auto")
            require(orientation in setOf("auto", "portrait", "landscape")) { "orientação inválida" }
            val brightness = if (c.isNull("brightness")) null else c.getInt("brightness").also { require(it in 10..255) }
            return Policy(versionId, mode, start, apps, feats, c.optBoolean("status_bar_disabled", mode == "single_app"), restr,
                c.optBoolean("keep_screen_on", true), c.optBoolean("stay_on_plugged", false), orientation, brightness, window, maint, sync)
        }
    }
}
