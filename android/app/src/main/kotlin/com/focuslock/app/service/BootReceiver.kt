package com.focuslock.app.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/** Starts the foreground service at boot, before the desktop is interactive on other platforms — see spec. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        ContextCompat.startForegroundService(context, Intent(context, FocusLockForegroundService::class.java))
        HeartbeatAlarmReceiver.schedule(context)
    }
}
