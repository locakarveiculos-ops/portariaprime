package br.com.portariaprime.kiosk.core

import java.security.MessageDigest
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Códigos de recuperação offline: o aparelho guarda só PBKDF2-HMAC-SHA256 (sal por código),
 * gerados no navegador do síndico (mesmo algoritmo, ver src/lib/mdm.ts). Uso único, limite de
 * tentativas com bloqueio progressivo contado por tempo desde o boot (não pelo relógio de parede).
 */
data class StoredCode(val idx: Int, val salt: String, val hash: String, val iterations: Int, val used: Boolean)

class RecoveryCodes(private val codes: List<StoredCode>) {
    sealed class Result {
        data class Ok(val idx: Int) : Result()
        object Wrong : Result()
        data class Locked(val retryInMs: Long) : Result()
        object NoCodes : Result()
    }

    fun verify(input: String, attempts: Attempts, nowElapsed: Long): Result {
        if (codes.none { !it.used }) return Result.NoCodes
        attempts.lockedUntil(nowElapsed)?.let { return Result.Locked(it - nowElapsed) }
        val norm = normalize(input)
        if (norm.length != 12) { attempts.fail(nowElapsed); return Result.Wrong }
        // Compara com todos (tempo constante entre códigos) e só aceita não usado.
        var hit: StoredCode? = null
        for (c in codes) {
            val ok = MessageDigest.isEqual(pbkdf2Hex(norm, c.salt, c.iterations).toByteArray(), c.hash.toByteArray())
            if (ok && !c.used) hit = c
        }
        return if (hit != null) { attempts.reset(); Result.Ok(hit.idx) } else { attempts.fail(nowElapsed); Result.Wrong }
    }

    companion object {
        fun normalize(s: String) = s.uppercase().filter { it in '0'..'9' || it in 'A'..'Z' }

        fun pbkdf2Hex(code: String, saltHex: String, iterations: Int): String {
            val salt = saltHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            val f = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            val bytes = f.generateSecret(PBEKeySpec(normalize(code).toCharArray(), salt, iterations, 256)).encoded
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}

/** 5 erros → bloqueio de 15 min; cada erro seguinte dobra (máx. 4 h). Persistido pelo chamador. */
class Attempts(var failures: Int = 0, var lockUntilElapsed: Long = 0, var bootCount: Int = 0) {
    fun lockedUntil(now: Long): Long? = lockUntilElapsed.takeIf { it > now }

    fun fail(now: Long) {
        failures++
        if (failures >= 5) {
            val mins = (15L shl (failures - 5).coerceAtMost(4)).coerceAtMost(240)
            lockUntilElapsed = now + mins * 60_000
        }
    }

    fun reset() { failures = 0; lockUntilElapsed = 0 }

    /** Reboot zera o relógio: bloqueio ativo é reiniciado com a duração cheia (reboot não fura o limite). */
    fun onBoot(newBoot: Int, now: Long) {
        if (newBoot != bootCount) {
            if (lockUntilElapsed > 0 || failures >= 5) lockUntilElapsed = now + 15 * 60_000
            bootCount = newBoot
        }
    }
}
