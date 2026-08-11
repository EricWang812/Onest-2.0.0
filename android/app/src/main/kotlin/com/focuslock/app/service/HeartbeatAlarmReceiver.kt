package com.focuslock.app.service

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.core.content.ContextCompat

/**
 * The AlarmManager side of the restart guarantee: fires periodically and
 * simply re-issues startForegroundService, which is a no-op if the service
 * is already alive and a real restart if something (a very aggressive OEM
 * battery-management system, e.g.) killed it despite START_STICKY. This is
 * Android's closest equivalent to the desktop watchdog process — there is
 * no way for a regular app to run a second always-alive background process
 * on Android the way the desktop daemon+watchdog pair does.
 */
class HeartbeatAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        ContextCompat.startForegroundService(context, Intent(context, FocusLockForegroundService::class.java))
        schedule(context)
    }

    companion object {
        private const val INTERVAL_MS = 60_000L // AlarmManager coalesces more aggressively than this in Doze; see DECISIONS.md.

        fun schedule(context: Context) {
            val am = context.getSystemService(AlarmManager::class.java) ?: return
            val pendingIntent = PendingIntent.getBroadcast(
                context, 0, Intent(context, HeartbeatAlarmReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            am.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + INTERVAL_MS,
                pendingIntent,
            )
        }
    }
}
