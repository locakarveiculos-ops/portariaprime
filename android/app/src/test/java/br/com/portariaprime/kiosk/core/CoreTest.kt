package br.com.portariaprime.kiosk.core

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CoreTest {
    private val ok = """{"mode":"single_app","start_path":"portaria","apps":[],"lock_task_features":["global_actions","system_info"],
      "status_bar_disabled":true,"restrictions":["no_debugging","no_factory_reset"],"keep_screen_on":true,"stay_on_plugged":false,
      "orientation":"auto","brightness":null,"system_update":{"type":"automatic"},"maintenance_max_minutes":30,"sync_interval_seconds":300}"""

    @Test fun politicaValidaEhAceita() {
        val p = Policy.parse("v1", JSONObject(ok))
        assertTrue(p.singleApp)
        assertEquals(setOf("no_debugging", "no_factory_reset"), p.restrictions)
        assertNull(p.updateWindow)
    }

    @Test fun cameraNuncaBloqueadaECampoDesconhecidoRecusado() {
        assertThrows(IllegalArgumentException::class.java) { Policy.parse("v", JSONObject(ok).put("restrictions", org.json.JSONArray(listOf("no_camera")))) }
        assertThrows(IllegalArgumentException::class.java) { Policy.parse("v", JSONObject(ok).put("shell", "id")) }
        assertThrows(IllegalArgumentException::class.java) { Policy.parse("v", JSONObject(ok).put("lock_task_features", org.json.JSONArray(listOf("home")))) }
        assertThrows(IllegalArgumentException::class.java) { Policy.parse("v", JSONObject(ok).put("apps", org.json.JSONArray(listOf("com.whatsapp")))) }
    }

    @Test fun navegacaoSoNaOrigemDoApp() {
        val g = NavigationGuard("https://portariaprime.vercel.app", setOf("https://abc.supabase.co"))
        assertEquals(NavigationGuard.Decision.ALLOW, g.navigation("https://portariaprime.vercel.app/c/cond/portaria"))
        assertEquals(NavigationGuard.Decision.ALLOW, g.navigation("https://portariaprime.vercel.app/entrar?next=/c/x"))
        for (bad in listOf("intent://scan#Intent;package=com.android.chrome;end", "file:///sdcard/a.html", "content://x/y", "javascript:alert(1)",
            "http://portariaprime.vercel.app/c/x", "https://evil.example/c/x", "https://portariaprime.vercel.app.evil.example/c/x",
            "https://user@portariaprime.vercel.app/c/x", "https://portariaprime.vercel.app/admin", "market://details?id=x", "tel:123"))
            assertEquals(bad, NavigationGuard.Decision.BLOCK, g.navigation(bad))
        assertEquals(NavigationGuard.Decision.PDF_VIEWER, g.navigation("https://abc.supabase.co/storage/v1/object/sign/tenant-private/a/receipt.pdf?token=x"))
        assertTrue(g.resource("https://abc.supabase.co/rest/v1/rpc/x"))
        assertFalse(g.resource("https://cdn.evil.example/x.js"))
        assertTrue(g.mayUseCamera("https://portariaprime.vercel.app/"))
        assertFalse(g.mayUseCamera("https://abc.supabase.co"))
        assertThrows(IllegalArgumentException::class.java) { g.startUrl("../../x", "portaria") }
        assertEquals("https://portariaprime.vercel.app/c/cond-a/portaria", g.startUrl("cond-a", "portaria"))
    }

    @Test fun manutencaoExpiraPorTempoDesdeBootENaoSobreviveAReboot() {
        val s = MaintenanceClock.start(1_000, 7, 15, 30, "sess", "settings")
        assertTrue(MaintenanceClock.isActive(s, 1_000 + 14 * 60_000, 7))
        assertFalse(MaintenanceClock.isActive(s, 1_000 + 15 * 60_000, 7))
        assertFalse("reboot encerra", MaintenanceClock.isActive(s, 2_000, 8))
        assertThrows(IllegalArgumentException::class.java) { MaintenanceClock.start(0, 1, 60, 30, null, "settings") }
    }

    @Test fun codigosOfflineUsoUnicoETentativasLimitadas() {
        val salt = "00112233445566778899aabbccddeeff"
        val code = "ABCD-EFGH-JKMN"
        val stored = listOf(StoredCode(0, salt, RecoveryCodes.pbkdf2Hex(code, salt, 1000), 1000, false),
            StoredCode(1, salt, RecoveryCodes.pbkdf2Hex("2345-6789-ABCD", salt, 1000), 1000, true))
        val att = Attempts()
        val rc = RecoveryCodes(stored)
        assertEquals(RecoveryCodes.Result.Ok(0), rc.verify("abcd efgh jkmn", att, 0))
        assertEquals("já usado não vale", RecoveryCodes.Result.Wrong, rc.verify("2345-6789-ABCD", att, 0))
        repeat(4) { rc.verify("ZZZZ-ZZZZ-ZZZZ", att, 0) }
        val locked = rc.verify(code, att, 1_000)
        assertTrue(locked is RecoveryCodes.Result.Locked)
        att.onBoot(att.bootCount + 1, 0)
        assertTrue("reboot não fura o bloqueio", rc.verify(code, att, 60_000) is RecoveryCodes.Result.Locked)
        assertEquals(RecoveryCodes.Result.NoCodes, RecoveryCodes(stored.map { it.copy(used = true) }).verify(code, Attempts(), 0))
    }

    @Test fun pbkdf2ConfereComVetorDoNavegador() {
        // Mesmo vetor de tests/mdm-frontend.test.mjs (node:crypto pbkdf2Sync).
        val h = RecoveryCodes.pbkdf2Hex("ABCDEFGHJKMN", "00112233445566778899aabbccddeeff", 1000)
        assertEquals(64, h.length)
        assertEquals(h, RecoveryCodes.pbkdf2Hex("abcd-efgh-jkmn", "00112233445566778899aabbccddeeff", 1000))
    }

    @Test fun backoffCresceComTeto() {
        assertEquals(300, Backoff.nextDelaySeconds(300, 0))
        assertEquals(30, Backoff.nextDelaySeconds(300, 1))
        assertTrue(Backoff.nextDelaySeconds(300, 20) <= 1800)
    }

    @Test fun soOCondominioInscritoEAreasDeOperacao() {
        val g = NavigationGuard("https://portariaprime.vercel.app", emptySet())
        val ok = NavigationGuard.Decision.ALLOW; val no = NavigationGuard.Decision.BLOCK
        assertEquals(ok, g.navigation("https://portariaprime.vercel.app/c/cond-a/portaria", "cond-a"))
        assertEquals(ok, g.navigation("https://portariaprime.vercel.app/c/cond-a/configuracoes?m=dispositivos", "cond-a"))
        assertEquals("outro condomínio", no, g.navigation("https://portariaprime.vercel.app/c/cond-b/portaria", "cond-a"))
        for (p in listOf("/admin", "/org", "/contratar", "/onboarding", "/planos", "/c/cond-a/../cond-b/portaria", "/c/cond-a/inexistente", "/checkout/retorno"))
            assertEquals(p, no, g.navigation("https://portariaprime.vercel.app$p", "cond-a"))
        // Loopback http só em laboratório.
        assertEquals(no, g.navigation("http://127.0.0.1:3017/c/cond-a/portaria", "cond-a"))
        val lab = NavigationGuard("http://127.0.0.1:3017", emptySet(), labLoopback = true)
        assertEquals(ok, lab.navigation("http://127.0.0.1:3017/c/cond-a/portaria", "cond-a"))
        assertEquals(no, lab.navigation("http://10.0.2.2:3017/c/cond-a/portaria", "cond-a"))
    }
}
