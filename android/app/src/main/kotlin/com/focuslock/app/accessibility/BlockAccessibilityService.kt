package com.focuslock.app.accessibility

import android.accessibilityservice.AccessibilityService
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.view.accessibility.AccessibilityEvent
import com.focuslock.app.blocklist.Blocklist
import com.focuslock.app.data.AppDatabase
import com.focuslock.app.shield.ShieldActivity
import java.util.concurrent.TimeUnit

/**
 * Detects the foreground app via TYPE_WINDOW_STATE_CHANGED (primary path)
 * and launches the full-screen shield when it matches a blocked category's
 * package fragments. Per spec, does NOT call killBackgroundProcesses —
 * relaunching the shield on top is what actually persists, since the user
 * can otherwise just relaunch a killed app instantly. UsageStatsManager
 * polling (usageStatsFallbackForegroundPackage) exists as the documented
 * fallback for OEMs that deliver window-state events unreliably, but this
 * service does not currently call it on a timer — wiring a periodic
 * fallback poll is a reasonable follow-up, not done here for time. Not
 * verified on a real device — see DECISIONS.md.
 */
class BlockAccessibilityService : AccessibilityService() {
    private var lastShieldedPackage: String? = null

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return
        if (pkg == packageName) return // never shield ourselves

        val db = AppDatabase.get(applicationContext)
        val active = db.activeSessionDao().get() ?: return
        if (System.currentTimeMillis() >= active.endsAt) return
        val categories = active.categoriesCsv.split(",").filter { it.isNotBlank() }.toSet()
        val fragments = Blocklist.packageFragmentsFor(categories)
        val isBlocked = fragments.any { pkg.contains(it) }

        if (isBlocked) {
            if (lastShieldedPackage == pkg) return // shield already up for this app
            lastShieldedPackage = pkg
            val intent = Intent(this, ShieldActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra(ShieldActivity.EXTRA_BLOCKED_PACKAGE, pkg)
                putExtra(ShieldActivity.EXTRA_ENDS_AT, active.endsAt)
            }
            startActivity(intent)
        } else {
            lastShieldedPackage = null
        }
    }

    override fun onInterrupt() {}

    /** Fallback path per spec — usable by a periodic poll if TYPE_WINDOW_STATE_CHANGED proves unreliable on a given OEM build. */
    fun usageStatsFallbackForegroundPackage(context: Context): String? {
        val usm = context.getSystemService(UsageStatsManager::class.java) ?: return null
        val end = System.currentTimeMillis()
        val begin = end - TimeUnit.SECONDS.toMillis(10)
        val events = usm.queryEvents(begin, end)
        var last: String? = null
        val event = android.app.usage.UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.eventType == android.app.usage.UsageEvents.Event.MOVE_TO_FOREGROUND) last = event.packageName
        }
        return last
    }
}
