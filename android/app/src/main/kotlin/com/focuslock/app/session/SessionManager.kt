package com.focuslock.app.session

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.focuslock.app.crypto.CryptoUtils
import com.focuslock.app.data.ActiveSessionEntity
import com.focuslock.app.data.AppDatabase
import com.focuslock.app.data.SessionEntity
import com.focuslock.app.relay.RelayClient
import com.focuslock.app.vpn.FocusLockVpnService
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

const val MAX_SESSION_DURATION_S = 8 * 60 * 60

/**
 * Monotonic-anchored, mirroring desktop/src/daemon/clock.ts: remaining time
 * is computed from SystemClock.elapsedRealtime() (guaranteed monotonic,
 * unaffected by the user changing the wall clock or timezone) rather than
 * System.currentTimeMillis(), so a live foreground service isn't fooled by
 * a clock rolled forward mid-session. Same one-process-lifetime caveat as
 * the desktop version applies — see DECISIONS.md.
 */
class SessionClock(startedAtMs: Long, endsAtMs: Long) {
    private val durationMs = endsAtMs - startedAtMs
    private val monoStartMs = SystemClock.elapsedRealtime()

    fun remainingMs(): Long = (durationMs - (SystemClock.elapsedRealtime() - monoStartMs)).coerceAtLeast(0)
    fun isExpired(): Boolean = remainingMs() <= 0
}

data class DeviceIdentity(
    val deviceId: String,
    val groupId: String,
    val publicKeyB64: String,
    val privateKeySeedB64: String,
)

interface SessionListener {
    fun onStateChanged()
    fun onSessionComplete(durationLabel: String, label: String?)
}

/**
 * Android's equivalent of desktop/src/daemon/session-manager.ts. Runs
 * inside FocusLockForegroundService — see service/FocusLockForegroundService.kt.
 * Deliberately has no method that ends a session early.
 */
class SessionManager(
    private val context: Context,
    private val db: AppDatabase,
    private val relay: RelayClient,
    val identity: DeviceIdentity,
    private val listener: SessionListener,
) {
    var clock: SessionClock? = null
        private set
    var currentCategories: Set<String> = emptySet()
        private set
    var currentLabel: String? = null
        private set
    private var currentSessionId: String? = null
    private var currentStartedAt: Long = 0

    fun isRunning(): Boolean = clock != null

    fun recoverOnStartup() {
        val row = db.activeSessionDao().get()
        val now = System.currentTimeMillis()
        if (row != null && now < row.endsAt && (row.endsAt - row.startedAt) <= MAX_SESSION_DURATION_S * 1000L) {
            currentSessionId = row.sessionId
            currentCategories = row.categoriesCsv.split(",").filter { it.isNotBlank() }.toSet()
            currentLabel = row.label
            currentStartedAt = row.startedAt
            clock = SessionClock(row.startedAt, row.endsAt)
            applyBlock(currentCategories)
        } else {
            removeBlock()
            db.activeSessionDao().clear()
        }
    }

    fun startSession(durationS: Int, categories: Set<String>, label: String?) {
        check(!isRunning()) { "a session is already active" }
        require(durationS in 1..MAX_SESSION_DURATION_S) { "duration must be between 1s and ${MAX_SESSION_DURATION_S}s" }
        require(categories.isNotEmpty()) { "at least one category is required" }

        val startedAt = System.currentTimeMillis()
        val endsAt = startedAt + durationS * 1000L
        val sessionId = UUID.randomUUID().toString().replace("-", "")

        val unsigned = JSONObject().apply {
            put("group_id", identity.groupId)
            put("session_id", sessionId)
            put("started_at", startedAt)
            put("ends_at", endsAt)
            put("categories", JSONArray(categories.toList()))
            put("label", label)
            put("origin_device", identity.deviceId)
            put("nonce", UUID.randomUUID().toString())
        }
        val signature = CryptoUtils.sign(CryptoUtils.canonicalize(unsigned), identity.privateKeySeedB64)
        val record = JSONObject(unsigned.toString()).apply { put("signature", signature) }

        db.activeSessionDao().set(
            ActiveSessionEntity(
                sessionId = sessionId, endsAt = endsAt, startedAt = startedAt,
                categoriesCsv = categories.joinToString(","), label = label, originDevice = identity.deviceId,
            ),
        )
        db.sessionDao().insert(
            SessionEntity(
                id = sessionId, startedAt = startedAt, endedAt = null, plannedDurationS = durationS,
                actualDurationS = null, label = label, completed = false, originDevice = identity.deviceId,
            ),
        )

        currentSessionId = sessionId
        currentCategories = categories
        currentLabel = label
        currentStartedAt = startedAt
        clock = SessionClock(startedAt, endsAt)

        applyBlock(categories)
        relay.publishSession(record)
        listener.onStateChanged()
    }

    fun onRemoteSessionUpdate(record: JSONObject) {
        if (record.optString("group_id") != identity.groupId) return
        if (record.optString("session_id") == currentSessionId) return
        if (isRunning()) return

        val unsigned = JSONObject(record.toString()).apply { remove("signature") }
        val ok = CryptoUtils.verify(CryptoUtils.canonicalize(unsigned), record.optString("signature"), identity.publicKeyB64)
        if (!ok) return

        val startedAt = record.optLong("started_at")
        val endsAt = record.optLong("ends_at")
        val now = System.currentTimeMillis()
        if (endsAt <= now || (endsAt - startedAt) > MAX_SESSION_DURATION_S * 1000L) return

        val categoriesArr = record.optJSONArray("categories") ?: JSONArray()
        val categories = (0 until categoriesArr.length()).map { categoriesArr.getString(it) }.toSet()
        val label = record.optString("label", null)
        val sessionId = record.optString("session_id")

        db.activeSessionDao().set(
            ActiveSessionEntity(
                sessionId = sessionId, endsAt = endsAt, startedAt = startedAt,
                categoriesCsv = categories.joinToString(","), label = label, originDevice = record.optString("origin_device"),
            ),
        )
        db.sessionDao().insert(
            SessionEntity(
                id = sessionId, startedAt = startedAt, endedAt = null,
                plannedDurationS = ((endsAt - startedAt) / 1000).toInt(), actualDurationS = null,
                label = label, completed = false, originDevice = record.optString("origin_device"),
            ),
        )

        currentSessionId = sessionId
        currentCategories = categories
        currentLabel = label
        currentStartedAt = startedAt
        clock = SessionClock(startedAt, endsAt)
        applyBlock(categories)
        listener.onStateChanged()
    }

    /** Called on a ~1s tick from the foreground service. */
    fun tick() {
        val c = clock ?: return
        if (c.isExpired()) completeSession()
        else listener.onStateChanged()
    }

    private fun completeSession() {
        val sessionId = currentSessionId ?: return
        val startedAt = currentStartedAt
        val label = currentLabel

        removeBlock()
        db.activeSessionDao().clear()
        val endedAt = System.currentTimeMillis()
        val actualDurationS = ((endedAt - startedAt) / 1000).toInt()
        db.sessionDao().complete(sessionId, endedAt, actualDurationS)

        clock = null
        currentSessionId = null
        currentCategories = emptySet()
        currentLabel = null

        val h = actualDurationS / 3600
        val m = (actualDurationS % 3600) / 60
        val durationLabel = if (h > 0) "${h}h ${m}m" else "${m}m"

        fireCompletionNotification(durationLabel, label)
        listener.onSessionComplete(durationLabel, label)
        listener.onStateChanged()
    }

    private fun applyBlock(categories: Set<String>) {
        val intent = Intent(context, FocusLockVpnService::class.java).apply {
            putExtra(FocusLockVpnService.EXTRA_CATEGORIES, categories.toTypedArray())
        }
        context.startService(intent)
    }

    private fun removeBlock() {
        context.stopService(Intent(context, FocusLockVpnService::class.java))
    }

    private fun fireCompletionNotification(durationLabel: String, label: String?) {
        val channelId = "focuslock_complete"
        val nm = NotificationManagerCompat.from(context)
        val notification = NotificationCompat.Builder(context, channelId)
            .setContentTitle("Focus session complete")
            .setContentText(if (label != null) "$durationLabel — $label" else durationLabel)
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setAutoCancel(true)
            .build()
        try {
            nm.notify(2, notification)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS not granted (API 33+) — the session still completed correctly.
        }
    }
}
