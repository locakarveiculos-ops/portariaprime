package br.com.portariaprime.kiosk

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection

/**
 * Canal autenticado com o backend. Somente HTTPS (validação padrão de certificado; network security
 * config bloqueia cleartext e CAs do usuário). Cada requisição é assinada pela chave do Keystore.
 */
class Api(private val base: String, private val store: Store, private val ctx: android.content.Context) {
    class HttpException(val status: Int, message: String) : IOException(message)

    fun enroll(token: String, publicKey: String, info: JSONObject): JSONObject {
        val agent = store.agentId
        val proof = DeviceIdentity.signCandidate(ctx, "enroll\n$token\n$agent")
        return post("/api/totem/kiosk-enroll", JSONObject().put("token", token).put("agentId", agent).put("publicKey", publicKey)
            .put("proof", proof).put("info", info).toString(), emptyMap())
    }

    fun signed(path: String, body: JSONObject): JSONObject {
        val device = store.deviceId ?: throw IOException("não inscrito")
        val text = body.toString()
        val counter = store.nextCounter()
        val sig = DeviceIdentity.sign(ctx, "POST\n$path\n$device\n$counter\n${sha256(text)}")
        return post(path, text, mapOf("X-PP-Device" to device, "X-PP-Counter" to counter.toString(), "X-PP-Signature" to sig))
    }

    private fun post(path: String, body: String, headers: Map<String, String>): JSONObject {
        val c = URL(base + path).openConnection() as HttpURLConnection
        require(c is HttpsURLConnection || BuildConfig.LAB_LOOPBACK) { "somente HTTPS" }
        c.requestMethod = "POST"
        c.connectTimeout = 15_000; c.readTimeout = 20_000
        c.instanceFollowRedirects = false
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
        try {
            c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }?.take(256_000) ?: "{}"
            val json = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
            if (code !in 200..299) throw HttpException(code, json.optString("error", "HTTP $code"))
            return json
        } finally { c.disconnect() }
    }

    companion object {
        fun sha256(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
