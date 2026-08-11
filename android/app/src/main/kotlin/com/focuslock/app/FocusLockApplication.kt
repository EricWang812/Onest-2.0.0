package com.focuslock.app

import android.app.Application
import com.focuslock.app.service.HeartbeatAlarmReceiver

class FocusLockApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        HeartbeatAlarmReceiver.schedule(this)
    }
}
