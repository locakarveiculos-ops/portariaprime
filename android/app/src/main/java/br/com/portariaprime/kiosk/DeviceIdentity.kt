package br.com.portariaprime.kiosk

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Chave de identidade do aparelho: EC P-256 gerada DENTRO do Android Keystore (StrongBox quando houver),
 * não exportável. Clonar o armazenamento do app não clona a chave.
 *
 * Reinscrição segura: a chave nova é gerada no alias que NÃO está em uso e só vira a ativa depois que o
 * servidor aceita a inscrição (commit). Um código errado/expirado não destrói a identidade atual.
 */
object DeviceIdentity {
    private val ALIASES = listOf("pp_kiosk_identity", "pp_kiosk_identity_b")
    private fun ks() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("kiosk", Context.MODE_PRIVATE)
    private fun active(ctx: Context) = prefs(ctx).getString("key_alias", ALIASES[0])!!
    private fun spare(ctx: Context) = ALIASES.first { it != active(ctx) }

    /** Gera a chave candidata (alias livre) e devolve a pública (SPKI DER, base64). */
    fun candidate(ctx: Context): String {
        val alias = spare(ctx)
        ks().deleteEntry(alias)
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply { if (strongBox && Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(true) }
            .build()
        val g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        val pair = try { g.initialize(spec(true)); g.generateKeyPair() }
                   catch (_: Exception) { g.initialize(spec(false)); g.generateKeyPair() }
        return Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)
    }

    /** Prova de posse na inscrição: assinada pela chave candidata. */
    fun signCandidate(ctx: Context, message: String) = sign(spare(ctx), message)

    /** Servidor aceitou: a candidata vira a ativa; a anterior é apagada. */
    fun commit(ctx: Context) {
        val old = active(ctx)
        prefs(ctx).edit().putString("key_alias", spare(ctx)).commit()
        ks().deleteEntry(old)
    }

    fun sign(ctx: Context, message: String) = sign(active(ctx), message)

    private fun sign(alias: String, message: String): String {
        val key = ks().getKey(alias, null) as PrivateKey
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(key)
        s.update(message.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(s.sign(), Base64.NO_WRAP)   // DER
    }
}
