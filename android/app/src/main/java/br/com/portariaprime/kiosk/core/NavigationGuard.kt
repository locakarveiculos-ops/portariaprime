package br.com.portariaprime.kiosk.core

import java.net.URI

/**
 * Decide o que a WebView pode abrir. Origens fixas no APK (build), nunca vindas do painel:
 * o síndico não consegue apontar o quiosque para um site externo.
 * Vale também para navegação interna do SPA (pushState), checada em doUpdateVisitedHistory.
 * `labLoopback`: só em build debug de laboratório aceita http://127.0.0.1 (adb reverse); release exige HTTPS.
 */
class NavigationGuard(appOrigin: String, private val extraOrigins: Set<String>, private val labLoopback: Boolean = false,
                      legacyOrigins: Set<String> = emptySet()) {
    private val app = origin(appOrigin, labLoopback) ?: error("APP_ORIGIN inválida")
    // Origem anterior do mesmo sistema (troca de domínio): tratada como o app para não prender um redirecionamento
    // vindo de link antigo. Só origens fixas no APK; o painel não acrescenta nada aqui.
    private val apps = setOf(app) + legacyOrigins.mapNotNull { origin(it, labLoopback) }

    enum class Decision { ALLOW, PDF_VIEWER, BLOCK }

    /**
     * Página (top-level ou pushState). Só a origem do app; dentro de /c/ apenas o condomínio inscrito
     * e áreas de operação (nunca /admin, /org, /contratar, outro condomínio). PDF assinado vai ao visualizador interno.
     */
    fun navigation(url: String, slug: String? = null): Decision {
        val u = parse(url) ?: return Decision.BLOCK
        val o = "${u.scheme}://${u.authority}"
        val p = path(u)
        if (o in apps) {
            if (p in setOf("/entrar", "/recuperar-senha", "/nova-senha", "/app")) return Decision.ALLOW
            val m = Regex("^/c/([a-z0-9][a-z0-9-]{1,46}[a-z0-9])(/([a-z-]+))?/?$").find(p) ?: return Decision.BLOCK
            if (slug != null && m.groupValues[1] != slug) return Decision.BLOCK
            val area = m.groupValues[3]
            return if (area.isEmpty() || area in AREAS) Decision.ALLOW else Decision.BLOCK
        }
        if (o in extraOrigins && p.startsWith("/storage/v1/object/sign/") && p.lowercase().endsWith(".pdf")) return Decision.PDF_VIEWER
        return Decision.BLOCK
    }

    /** Sub-recursos (fetch/XHR/imagens): app + backend legítimo (Supabase). */
    fun resource(url: String): Boolean {
        if (url.startsWith("data:") || url.startsWith("blob:")) return true
        val u = parse(url) ?: return false
        return "${u.scheme}://${u.authority}" in apps || "${u.scheme}://${u.authority}" in extraOrigins
    }

    /** Câmera (getUserMedia) só para a origem do app. */
    fun mayUseCamera(origin: String) = origin.trimEnd('/') in apps

    fun startUrl(slug: String, path: String): String {
        require(SLUG.matches(slug)) { "slug inválido" }
        require(path in setOf("portaria", "totem-equipe", "painel"))
        return "$app/c/$slug/$path"
    }

    private fun parse(url: String): URI? = try {
        URI(url).takeIf { ok(it, labLoopback) && it.rawUserInfo == null }
    } catch (_: Exception) { null }

    private fun path(u: URI) = u.rawPath ?: "/"

    companion object {
        private val SLUG = Regex("^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$")
        /** Áreas de operação/gestão local; configurações e assinatura continuam exigindo permissão no servidor. */
        val AREAS = setOf("portaria", "totem-equipe", "painel", "relatorios", "pessoas", "configuracoes", "avisos", "ajuda", "comprovante", "suporte", "aplicativo")

        private fun ok(u: URI, lab: Boolean) = !u.host.isNullOrEmpty() &&
            (u.scheme == "https" || (lab && u.scheme == "http" && u.host == "127.0.0.1"))

        fun origin(s: String, lab: Boolean = false): String? = try {
            URI(s).takeIf { ok(it, lab) }?.let { "${it.scheme}://${it.authority}" }
        } catch (_: Exception) { null }
    }
}
