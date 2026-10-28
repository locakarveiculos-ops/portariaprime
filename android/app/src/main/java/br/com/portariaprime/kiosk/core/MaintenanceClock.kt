package br.com.portariaprime.kiosk.core

/**
 * Prazo de manutenção contado localmente sem confiar no relógio de parede (alterável pelo usuário):
 * usa o tempo desde o boot (SystemClock.elapsedRealtime). Reboot zera esse relógio, então
 * manutenção NUNCA sobrevive a reinício: o boot encerra e reaplica a política.
 */
data class MaintenanceState(val active: Boolean, val bootCount: Int, val deadlineElapsedMs: Long, val sessionId: String?, val scope: String)

object MaintenanceClock {
    fun start(nowElapsed: Long, bootCount: Int, minutes: Int, maxMinutes: Int, sessionId: String?, scope: String): MaintenanceState {
        require(minutes in 1..maxMinutes) { "duração fora do limite da política" }
        return MaintenanceState(true, bootCount, nowElapsed + minutes * 60_000L, sessionId, scope)
    }

    /** Ativa só se no mesmo boot e antes do prazo. Qualquer dúvida = encerra (falha segura). */
    fun isActive(s: MaintenanceState?, nowElapsed: Long, bootCount: Int): Boolean =
        s != null && s.active && s.bootCount == bootCount && nowElapsed in 0 until s.deadlineElapsedMs

    fun remainingMs(s: MaintenanceState?, nowElapsed: Long, bootCount: Int): Long =
        if (isActive(s, nowElapsed, bootCount)) s!!.deadlineElapsedMs - nowElapsed else 0
}
