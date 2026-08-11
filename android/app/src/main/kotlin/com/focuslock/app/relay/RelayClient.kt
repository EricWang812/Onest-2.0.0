package com.focuslock.app.relay

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * WebSocket client matching the relay's protocol (relay/src/server.ts).
 * Callbacks are persistent listeners registered once (`onSessionUpdate`,
 * `onPairingMessage`, etc.) dispatched by the incoming message's `type`
 * field — never a one-shot "next message is my response" read. See
 * DECISIONS.md / relay/test/relay.test.ts for the race that pattern causes.
 */
class RelayClient(
    private val url: String,
    private val groupId: String,
    private val deviceId: String,
    private val deviceName: String,
    private val platform: String,
    private val pubkeyB64: String,
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private var socket: WebSocket? = null
    private var shouldReconnect = true
    private var reconnectDelayMs = 1000L
    private val handlers = mutableMapOf<String, MutableList<(JSONObject) -> Unit>>()

    fun on(type: String, handler: (JSONObject) -> Unit) {
        handlers.getOrPut(type) { mutableListOf() }.add(handler)
    }

    fun connect() {
        shouldReconnect = true
        open()
    }

    private fun open() {
        val request = Request.Builder().url(url).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectDelayMs = 1000L
                send(JSONObject().apply {
                    put("type", "hello")
                    put("group_id", groupId)
                    put("device_id", deviceId)
                    put("device_name", deviceName)
                    put("platform", platform)
                    put("pubkey", pubkeyB64)
                })
                handlers["connected"]?.forEach { it(JSONObject()) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val msg = JSONObject(text)
                    val type = msg.optString("type")
                    handlers[type]?.forEach { it(msg) }
                } catch (e: Exception) {
                    Log.w("RelayClient", "malformed message", e)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handlers["disconnected"]?.forEach { it(JSONObject()) }
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                handlers["disconnected"]?.forEach { it(JSONObject()) }
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            if (shouldReconnect) open()
        }, reconnectDelayMs)
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000)
    }

    fun disconnect() {
        shouldReconnect = false
        socket?.close(1000, "client disconnect")
    }

    private fun send(obj: JSONObject) {
        socket?.send(obj.toString())
    }

    fun publishSession(record: JSONObject) {
        send(JSONObject().apply { put("type", "session.publish"); put("record", record) })
    }

    fun hostStartPairing(code: String, saltHex: String, groupId: String) {
        send(JSONObject().apply {
            put("type", "pairing.host_start"); put("code", code); put("salt_hex", saltHex); put("group_id", groupId)
        })
    }

    fun joinerStartPairing(code: String) {
        send(JSONObject().apply { put("type", "pairing.joiner_start"); put("code", code) })
    }

    fun sendSpake2Msg(challengeId: String, payload: String) {
        send(JSONObject().apply { put("type", "pairing.spake2_msg"); put("challenge_id", challengeId); put("payload", payload) })
    }

    fun sendGroupKey(challengeId: String, blob: String) {
        send(JSONObject().apply { put("type", "pairing.group_key"); put("challenge_id", challengeId); put("blob", blob) })
    }
}
