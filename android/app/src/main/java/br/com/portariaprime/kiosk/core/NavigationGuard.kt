package br.com.portariaprime.kiosk.core

import java.net.URI

/**
 * Decide o que a WebView pode abrir. Origens fixas no APK (build), nunca vindas do painel:
 * o síndico não consegue apontar o quiosque para um site externo.
 */
class NavigationGuard(appOrigin: String, private val extraOrigins: Set<String>) {
    private val app = origin(appOrigin) ?: error("APP_ORIGIN inválida")

    enum class Decision { ALLOW, PDF_VIEWER, BLOCK }

    /** Navegação de página (top-level). Só a origem do app; PDF assinado do Storage vai ao visualizador interno. */
    fun navigation(url: String): Decision {
        val u = parse(url) ?: return Decision.BLOCK
        val o = "${u.scheme}://${u.authority}"
        if (o == app && path(u).startsWith("/c/")) return Decision.ALLOW
        if (o == app && (path(u) in setOf("/entrar", "/recuperar-senha", "/nova-senha", "/app", "/") || path(u).startsWith("/ajuda"))) return Decision.ALLOW
        if (o in extraOrigins && path(u).startsWith("/storage/v1/object/sign/") && path(u).lowercase().endsWith(".pdf")) return Decision.PDF_VIEWER
        return Decision.BLOCK
    }

    /** Sub-recursos (fetch/XHR/imagens): app + backend legítimo (Supabase). */
    fun resource(url: String): Boolean {
        if (url.startsWith("data:") || url.startsWith("blob:")) return true
        val u = parse(url) ?: return false
        return "${u.scheme}://${u.authority}" == app || "${u.scheme}://${u.authority}" in extraOrigins
    }

    /** Câmera (getUserMedia) só para a origem do app. */
    fun mayUseCamera(origin: String) = origin.trimEnd('/') == app

    fun startUrl(slug: String, path: String): String {
        require(Regex("^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$").matches(slug)) { "slug inválido" }
        require(path in setOf("portaria", "totem-equipe", "painel"))
        return "$app/c/$slug/$path"
    }

    private fun parse(url: String): URI? = try {
        URI(url).takeIf { it.scheme == "https" && it.rawUserInfo == null && !it.host.isNullOrEmpty() }
    } catch (_: Exception) { null }

    private fun path(u: URI) = u.rawPath ?: "/"

    companion object {
        fun origin(s: String): String? = try {
            URI(s).takeIf { it.scheme == "https" && !it.host.isNullOrEmpty() }?.let { "${it.scheme}://${it.authority}" }
        } catch (_: Exception) { null }
    }
}
