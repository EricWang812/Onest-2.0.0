package com.focuslock.app.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.focuslock.app.crypto.CryptoUtils
import com.focuslock.app.data.AppDatabase
import com.focuslock.app.data.SettingEntity
import com.focuslock.app.relay.RelayClient
import com.focuslock.app.session.DeviceIdentity
import com.focuslock.app.session.SessionListener
import com.focuslock.app.session.SessionManager
import org.json.JSONObject
import java.util.UUID

/**
 * The Android equivalent of the desktop daemon: owns the clock, the DB, the
 * relay connection, and enforcement. START_STICKY + a persistent
 * notification + exemption from battery optimization (requested once from
 * MainActivity's onboarding flow — see ui/MainActivity.kt) + restarted via
 * BOOT_COMPLETED (BootReceiver) and an AlarmManager heartbeat
 * (HeartbeatAlarmReceiver) are what stand in for the desktop's
 * watchdog-process design; Android does not allow a second always-running
 * background process the way a desktop OS does, so a single hardened
 * foreground service is the closest available equivalent. Not verified on
 * a real device/emulator — no Android environment was available in this
 * build. See DECISIONS.md.
 */
class FocusLockForegroundService : Service(), SessionListener {

    private lateinit var db: AppDatabase
    private lateinit var relay: RelayClient
    private lateinit var sessionManager: SessionManager
    private val tickHandler = Handler(Looper.getMainLooper())
    private val tickRunnable = object : Runnable {
        override fun run() {
            sessionManager.tick()
            tickHandler.postDelayed(this, 1000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        db = AppDatabase.get(applicationContext)
        val identity = bootstrapIdentity(db)
        val relayUrl = db.settingDao().get("relayUrl") ?: DEFAULT_RELAY_URL
        relay = RelayClient(relayUrl, identity.groupId, identity.deviceId, "Android device", "android", identity.publicKeyB64)
        sessionManager = SessionManager(applicationContext, db, relay, identity, this)

        relay.on("session.update") { msg ->
            val record = msg.optJSONObject("record")
            if (record != null) sessionManager.onRemoteSessionUpdate(record)
        }

        createNotificationChannels()
        sessionManager.recoverOnStartup()
        relay.connect()
        tickHandler.post(tickRunnable)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildForegroundNotification())

        when (intent?.action) {
            ACTION_START_SESSION -> {
                val durationS = intent.getIntExtra(EXTRA_DURATION_S, 0)
                val categories = intent.getStringArrayExtra(EXTRA_CATEGORIES)?.toSet() ?: emptySet()
                val label = intent.getStringExtra(EXTRA_LABEL)
                if (durationS > 0 && categories.isNotEmpty() && !sessionManager.isRunning()) {
                    try {
                        sessionManager.startSession(durationS, categories, label)
                    } catch (e: Exception) {
                        // Already running / invalid duration — surfaced to the UI via onStateChanged polling, not thrown here.
                    }
                }
            }
        }
        // No ACTION_STOP_SESSION / ACTION_CANCEL exists. That is intentional — see class doc.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        tickHandler.removeCallbacks(tickRunnable)
        // Deliberately does not stop the VPN/blocking here — killing this
        // service must not unblock anything. BOOT_COMPLETED / the
        // AlarmManager heartbeat bring it back; on restart,
        // sessionManager.recoverOnStartup() re-applies from the DB.
        super.onDestroy()
    }

    override fun onStateChanged() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, buildForegroundNotification())
    }

    override fun onSessionComplete(durationLabel: String, label: String?) {
        // Per spec: device admin (which blocks uninstall) is only held while
        // a session is active — deactivate it now that one isn't.
        com.focuslock.app.admin.FocusLockDeviceAdminReceiver.deactivate(applicationContext)
    }

    private fun buildForegroundNotification() = NotificationCompat.Builder(this, CHANNEL_ENFORCEMENT)
        .setContentTitle(if (sessionManager.isRunning()) "Focus session active" else "Focus Lock")
        .setContentText(
            if (sessionManager.isRunning()) {
                val remainingS = sessionManager.clock?.remainingMs()?.div(1000) ?: 0
                "Categories: ${sessionManager.currentCategories.joinToString(", ")} — ${remainingS / 60}m remaining"
            } else "No session running",
        )
        .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
        .setOngoing(true)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build()

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ENFORCEMENT, "Focus Lock enforcement", NotificationManager.IMPORTANCE_LOW),
        )
        nm.createNotificationChannel(
            NotificationChannel("focuslock_complete", "Session complete", NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    companion object {
        const val NOTIFICATION_ID = 1
        const val CHANNEL_ENFORCEMENT = "focuslock_enforcement"
        const val ACTION_START_SESSION = "com.focuslock.app.START_SESSION"
        const val EXTRA_DURATION_S = "durationS"
        const val EXTRA_CATEGORIES = "categories"
        const val EXTRA_LABEL = "label"
        const val DEFAULT_RELAY_URL = "ws://10.0.2.2:8787/ws" // emulator-host loopback default; real deployments set relayUrl in settings

        fun bootstrapIdentity(db: AppDatabase): DeviceIdentity {
            val settingDao = db.settingDao()
            var groupId = settingDao.get("group_id")
            var deviceId = settingDao.get("device_id")
            var pub = settingDao.get("device_pubkey")
            var priv = settingDao.get("device_privkey")

            if (groupId == null) {
                groupId = UUID.randomUUID().toString().replace("-", "")
                settingDao.set(SettingEntity("group_id", groupId))
            }
            if (deviceId == null || pub == null || priv == null) {
                val kp = CryptoUtils.generateKeyPair()
                deviceId = UUID.randomUUID().toString().replace("-", "")
                pub = kp.publicKeyB64
                priv = kp.privateKeySeedB64
                settingDao.set(SettingEntity("device_id", deviceId))
                settingDao.set(SettingEntity("device_pubkey", pub))
                settingDao.set(SettingEntity("device_privkey", priv))
            }
            return DeviceIdentity(deviceId, groupId, pub, priv)
        }
    }
}
