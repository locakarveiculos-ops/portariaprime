package br.com.portariaprime.kiosk.core

/** Intervalo de sincronização: o da política quando ok; exponencial com teto em falha (economia de bateria). */
object Backoff {
    fun nextDelaySeconds(baseSeconds: Int, consecutiveFailures: Int, jitter: Double = 0.0): Long {
        if (consecutiveFailures <= 0) return baseSeconds.toLong()
        val exp = 30L shl (consecutiveFailures - 1).coerceAtMost(6)   // 30 s, 60 s … 32 min
        val capped = exp.coerceAtMost(maxOf(baseSeconds.toLong() * 4, 1800L))
        return (capped * (1 + jitter.coerceIn(0.0, 0.2))).toLong().coerceAtLeast(30)
    }
}
