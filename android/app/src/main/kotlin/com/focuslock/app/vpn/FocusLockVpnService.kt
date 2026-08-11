package com.focuslock.app.vpn

import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import com.focuslock.app.blocklist.Blocklist
import com.focuslock.app.blocklist.NEVER_BLOCK_DOMAINS
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import kotlin.concurrent.thread

/**
 * Local-only DNS-interception VPN: becomes the device's DNS resolver,
 * inspects each query, and either forwards it upstream (real answer) or
 * answers 0.0.0.0 itself for a blocked domain. Only DNS traffic is routed
 * through the tunnel (a single /32 route to our own fake DNS server IP) —
 * every other packet continues over the device's normal network path
 * unaffected, so this never proxies or sees general app traffic, matching
 * spec: "Do not route traffic anywhere external — the VPN terminates locally."
 *
 * The IP/UDP/DNS packet parsing below is written by hand (Android has no
 * built-in DNS packet codec) and has NOT been exercised against a real
 * device or emulator — no Android environment was available in this build.
 * Treat this file as the highest-risk piece of the Android client and test
 * it first on real hardware. See DECISIONS.md.
 */
class FocusLockVpnService : VpnService() {
    private var tunFd: ParcelFileDescriptor? = null
    @Volatile private var running = false
    @Volatile private var blockedDomains: Set<String> = emptySet()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val categories = intent?.getStringArrayExtra(EXTRA_CATEGORIES)?.toSet() ?: emptySet()
        blockedDomains = Blocklist.domainsFor(categories) - NEVER_BLOCK_DOMAINS
        if (tunFd == null) startTunnel()
        return START_STICKY
    }

    private fun startTunnel() {
        val builder = Builder()
            .setSession("Focus Lock")
            .addAddress(FAKE_DNS_IP, 32)
            .addDnsServer(FAKE_DNS_IP)
            .addRoute(FAKE_DNS_IP, 32)
        tunFd = builder.establish() ?: return
        running = true
        thread(name = "focuslock-vpn-dns") { runLoop() }
    }

    private fun runLoop() {
        val fd = tunFd ?: return
        val input = FileInputStream(fd.fileDescriptor)
        val output = FileOutputStream(fd.fileDescriptor)
        val buf = ByteArray(4096)
        while (running) {
            val len = try { input.read(buf) } catch (e: Exception) { break }
            if (len <= 0) continue
            try {
                handlePacket(buf, len, output)
            } catch (e: Exception) {
                Log.w("FocusLockVpn", "packet handling failed", e)
            }
        }
    }

    private fun handlePacket(buf: ByteArray, len: Int, output: FileOutputStream) {
        // IPv4 only. Byte 0 high nibble = version; low nibble * 4 = header length.
        if (len < 20) return
        val version = (buf[0].toInt() shr 4) and 0xF
        if (version != 4) return
        val ipHeaderLen = (buf[0].toInt() and 0xF) * 4
        val protocol = buf[9].toInt() and 0xFF
        if (protocol != 17) return // UDP only — DNS

        val udpStart = ipHeaderLen
        if (len < udpStart + 8) return
        val srcPort = ((buf[udpStart].toInt() and 0xFF) shl 8) or (buf[udpStart + 1].toInt() and 0xFF)
        val dstPort = ((buf[udpStart + 2].toInt() and 0xFF) shl 8) or (buf[udpStart + 3].toInt() and 0xFF)
        if (dstPort != 53) return

        val dnsStart = udpStart + 8
        val dnsLen = len - dnsStart
        if (dnsLen < 12) return

        val queryName = parseQuestionName(buf, dnsStart, len) ?: return
        val isBlocked = blockedDomains.any { queryName == it || queryName.endsWith(".$it") }

        if (isBlocked) {
            val response = buildBlockedResponse(buf, len, ipHeaderLen, dnsStart, dnsLen)
            output.write(response)
        } else {
            forwardUpstream(buf, len, ipHeaderLen, srcPort, dnsStart, dnsLen, output)
        }
    }

    /** Parses the QNAME of the first question in a DNS message starting at [dnsStart]. */
    private fun parseQuestionName(buf: ByteArray, dnsStart: Int, totalLen: Int): String? {
        var pos = dnsStart + 12 // past the 12-byte DNS header
        val labels = mutableListOf<String>()
        while (pos < totalLen) {
            val labelLen = buf[pos].toInt() and 0xFF
            if (labelLen == 0) break
            if (labelLen and 0xC0 == 0xC0) return null // compression pointer in a question — unexpected for a client query, bail
            pos += 1
            if (pos + labelLen > totalLen) return null
            labels.add(String(buf, pos, labelLen, Charsets.US_ASCII))
            pos += labelLen
        }
        if (labels.isEmpty()) return null
        return labels.joinToString(".").lowercase()
    }

    /** Synthesizes an A-record response of 0.0.0.0, reversing src/dst so it routes back to the caller through the tun. */
    private fun buildBlockedResponse(orig: ByteArray, origLen: Int, ipHeaderLen: Int, dnsStart: Int, dnsLen: Int): ByteArray {
        val udpStart = ipHeaderLen
        val questionEnd = run {
            var pos = dnsStart + 12
            while (pos < dnsStart + dnsLen && orig[pos].toInt() != 0) pos += (orig[pos].toInt() and 0xFF) + 1
            pos + 1 + 4 // null label + QTYPE + QCLASS
        }
        val questionBytes = orig.copyOfRange(dnsStart + 12, questionEnd)

        val answer = ByteBuffer.allocate(16).apply {
            putShort(0xC00C.toShort()) // pointer to name at offset 12
            putShort(1) // TYPE A
            putShort(1) // CLASS IN
            putInt(60) // TTL
            putShort(4) // RDLENGTH
            put(byteArrayOf(0, 0, 0, 0)) // 0.0.0.0
        }.array()

        val dnsHeader = ByteBuffer.allocate(12).apply {
            put(orig, dnsStart, 2) // ID, echoed
            putShort(0x8180.toShort()) // QR=1 response, RD=1, RA=1, no error
            putShort(1) // QDCOUNT
            putShort(1) // ANCOUNT
            putShort(0) // NSCOUNT
            putShort(0) // ARCOUNT
        }.array()

        val dnsMessage = dnsHeader + questionBytes + answer
        return buildIpUdpPacket(orig, ipHeaderLen, udpStart, dnsMessage)
    }

    private fun buildIpUdpPacket(orig: ByteArray, ipHeaderLen: Int, udpStart: Int, dnsPayload: ByteArray): ByteArray {
        val udpLen = 8 + dnsPayload.size
        val totalLen = ipHeaderLen + udpLen
        val out = ByteArray(totalLen)

        // IP header: copy original, swap src/dst, fix total length, zero checksum (recomputed below).
        System.arraycopy(orig, 0, out, 0, ipHeaderLen)
        System.arraycopy(orig, 16, out, 12, 4) // dst -> src
        System.arraycopy(orig, 12, out, 16, 4) // src -> dst
        out[2] = ((totalLen shr 8) and 0xFF).toByte()
        out[3] = (totalLen and 0xFF).toByte()
        out[10] = 0; out[11] = 0
        val ipChecksum = checksum(out, 0, ipHeaderLen)
        out[10] = (ipChecksum shr 8).toByte(); out[11] = (ipChecksum and 0xFF).toByte()

        // UDP header: swap ports, set length, zero checksum (optional over IPv4, left as 0/unused).
        out[ipHeaderLen] = orig[udpStart + 2]; out[ipHeaderLen + 1] = orig[udpStart + 3]
        out[ipHeaderLen + 2] = orig[udpStart]; out[ipHeaderLen + 3] = orig[udpStart + 1]
        out[ipHeaderLen + 4] = ((udpLen shr 8) and 0xFF).toByte()
        out[ipHeaderLen + 5] = (udpLen and 0xFF).toByte()
        out[ipHeaderLen + 6] = 0; out[ipHeaderLen + 7] = 0

        System.arraycopy(dnsPayload, 0, out, ipHeaderLen + 8, dnsPayload.size)
        return out
    }

    private fun checksum(data: ByteArray, offset: Int, length: Int): Int {
        var sum = 0
        var i = offset
        while (i < offset + length - 1) {
            sum += ((data[i].toInt() and 0xFF) shl 8) or (data[i + 1].toInt() and 0xFF)
            i += 2
        }
        if (length % 2 == 1) sum += (data[offset + length - 1].toInt() and 0xFF) shl 8
        while (sum shr 16 != 0) sum = (sum and 0xFFFF) + (sum shr 16)
        return sum.inv() and 0xFFFF
    }

    /** Not blocked: forward the raw DNS query to a real upstream resolver, protected so it doesn't loop back into this VPN. */
    private fun forwardUpstream(orig: ByteArray, origLen: Int, ipHeaderLen: Int, srcPort: Int, dnsStart: Int, dnsLen: Int, output: FileOutputStream) {
        val socket = DatagramSocket()
        try {
            protect(socket) // exempts this socket from the VPN's own routing — required to avoid an infinite loop
            val query = orig.copyOfRange(dnsStart, dnsStart + dnsLen)
            socket.send(DatagramPacket(query, query.size, InetSocketAddress(UPSTREAM_DNS, 53)))
            val respBuf = ByteArray(1024)
            socket.soTimeout = 5000
            val respPacket = DatagramPacket(respBuf, respBuf.size)
            socket.receive(respPacket)
            val dnsResponse = respBuf.copyOfRange(0, respPacket.length)
            val packet = buildIpUdpPacket(orig, ipHeaderLen, ipHeaderLen, dnsResponse)
            output.write(packet)
        } catch (e: Exception) {
            Log.w("FocusLockVpn", "upstream DNS forward failed", e)
        } finally {
            socket.close()
        }
    }

    override fun onDestroy() {
        running = false
        try {
            tunFd?.close()
        } catch (e: Exception) {
            // best effort
        }
        tunFd = null
        super.onDestroy()
    }

    companion object {
        const val EXTRA_CATEGORIES = "categories"
        private const val FAKE_DNS_IP = "10.111.222.1"
        private const val UPSTREAM_DNS = "8.8.8.8"
    }
}
