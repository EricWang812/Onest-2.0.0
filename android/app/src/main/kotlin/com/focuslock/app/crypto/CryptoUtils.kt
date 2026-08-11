package com.focuslock.app.crypto

import android.util.Base64
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.engines.AESEngine
import org.bouncycastle.crypto.modes.GCMBlockCipher
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * Mirrors shared/src/crypto.ts's semantics (ed25519 signing over canonical
 * JSON, matching field-for-field) using BouncyCastle's lightweight API —
 * pure JVM, so it behaves identically across every minSdk 26+ device
 * regardless of the OS crypto provider's Ed25519 support, unlike
 * `java.security.Signature.getInstance("Ed25519")` which is only reliably
 * available from API 33+. NOT independently verified against the Node
 * implementation's output on real hardware — no device/emulator was
 * available in this build environment. See DECISIONS.md.
 */
object CryptoUtils {
    private val random = SecureRandom()

    data class KeyPair(val publicKeyB64: String, val privateKeySeedB64: String)

    fun generateKeyPair(): KeyPair {
        val seed = ByteArray(32)
        random.nextBytes(seed)
        val priv = Ed25519PrivateKeyParameters(seed, 0)
        val pub = priv.generatePublicKey()
        return KeyPair(
            publicKeyB64 = Base64.encodeToString(pub.encoded, Base64.NO_WRAP),
            privateKeySeedB64 = Base64.encodeToString(seed, Base64.NO_WRAP),
        )
    }

    /**
     * Canonical JSON: keys sorted, no whitespace — must byte-for-byte match
     * shared/src/crypto.ts's `canonicalize()` for cross-platform signatures
     * to verify. JSONObject does not preserve insertion order, so keys are
     * sorted explicitly here rather than relying on that.
     */
    fun canonicalize(obj: JSONObject): String {
        val keys = obj.keys().asSequence().sorted().toList()
        val sb = StringBuilder("{")
        keys.forEachIndexed { i, key ->
            if (i > 0) sb.append(",")
            sb.append(JSONObject.quote(key)).append(":")
            sb.append(canonicalizeValue(obj.get(key)))
        }
        sb.append("}")
        return sb.toString()
    }

    private fun canonicalizeValue(value: Any): String = when (value) {
        is JSONObject -> canonicalize(value)
        is JSONArray -> {
            val items = (0 until value.length()).joinToString(",") { canonicalizeValue(value.get(it)) }
            "[$items]"
        }
        is String -> JSONObject.quote(value)
        JSONObject.NULL -> "null"
        else -> value.toString()
    }

    fun sign(canonicalJson: String, privateKeySeedB64: String): String {
        val seed = Base64.decode(privateKeySeedB64, Base64.NO_WRAP)
        val priv = Ed25519PrivateKeyParameters(seed, 0)
        val signer = Ed25519Signer()
        signer.init(true, priv)
        val bytes = canonicalJson.toByteArray(Charsets.UTF_8)
        signer.update(bytes, 0, bytes.size)
        return Base64.encodeToString(signer.generateSignature(), Base64.NO_WRAP)
    }

    fun verify(canonicalJson: String, signatureB64: String, publicKeyB64: String): Boolean = try {
        val pub = Ed25519PublicKeyParameters(Base64.decode(publicKeyB64, Base64.NO_WRAP), 0)
        val signer = Ed25519Signer()
        signer.init(false, pub)
        val bytes = canonicalJson.toByteArray(Charsets.UTF_8)
        signer.update(bytes, 0, bytes.size)
        signer.verifySignature(Base64.decode(signatureB64, Base64.NO_WRAP))
    } catch (e: Exception) {
        false
    }

    fun sha256Hex(input: String): String {
        val digest = SHA256Digest()
        val bytes = input.toByteArray(Charsets.UTF_8)
        digest.update(bytes, 0, bytes.size)
        val out = ByteArray(digest.digestSize)
        digest.doFinal(out, 0)
        return out.joinToString("") { "%02x".format(it) }
    }

    /** AES-128-GCM decrypt, matching shared/src/pairing.ts's group-key transport format (12B IV | 16B tag | ciphertext). */
    fun aesGcmDecrypt(keyBytes: ByteArray, blobB64: String): String {
        val raw = Base64.decode(blobB64, Base64.NO_WRAP)
        val iv = raw.copyOfRange(0, 12)
        val tagAndCiphertext = raw.copyOfRange(12, raw.size)
        val cipher = GCMBlockCipher(AESEngine())
        cipher.init(false, AEADParameters(KeyParameter(keyBytes), 128, iv))
        val output = ByteArray(cipher.getOutputSize(tagAndCiphertext.size))
        val len = cipher.processBytes(tagAndCiphertext, 0, tagAndCiphertext.size, output, 0)
        val finalLen = cipher.doFinal(output, len)
        return String(output, 0, len + finalLen, Charsets.UTF_8)
    }
}
