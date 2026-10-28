package br.com.portariaprime.kiosk

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
 * não exportável. Clonar o armazenamento do app não clona a chave. Nova inscrição = nova chave.
 */
object DeviceIdentity {
    private const val ALIAS = "pp_kiosk_identity"
    private fun ks() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun rotate(): String {
        ks().deleteEntry(ALIAS)
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply { if (strongBox && Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(true) }
            .build()
        val g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        val pair = try { g.initialize(spec(true)); g.generateKeyPair() }
                   catch (_: Exception) { g.initialize(spec(false)); g.generateKeyPair() }
        return Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)  // SPKI DER
    }

    fun hasKey() = ks().containsAlias(ALIAS)

    fun sign(message: String): String {
        val key = ks().getKey(ALIAS, null) as PrivateKey
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(key)
        s.update(message.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(s.sign(), Base64.NO_WRAP)   // DER
    }

}
