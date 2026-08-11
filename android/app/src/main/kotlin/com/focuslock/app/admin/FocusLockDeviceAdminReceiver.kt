package com.focuslock.app.admin

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent

/**
 * Registering as device admin is what makes the app un-uninstallable while
 * active (Settings > Apps > Uninstall is greyed out for active device
 * admins). Per spec, admin is deactivated automatically once a session
 * completes — see FocusLockForegroundService.onSessionComplete, which calls
 * [deactivate]. Between sessions the user can uninstall normally; this is
 * the anti-lockout property, not a bug. Not verified on a real device.
 */
class FocusLockDeviceAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
    }

    companion object {
        fun componentName(context: Context) = ComponentName(context, FocusLockDeviceAdminReceiver::class.java)

        fun isActive(context: Context): Boolean {
            val dpm = context.getSystemService(DevicePolicyManager::class.java) ?: return false
            return dpm.isAdminActive(componentName(context))
        }

        fun deactivate(context: Context) {
            val dpm = context.getSystemService(DevicePolicyManager::class.java) ?: return
            if (dpm.isAdminActive(componentName(context))) {
                dpm.removeActiveAdmin(componentName(context))
            }
        }
    }
}
