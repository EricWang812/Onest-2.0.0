package com.focuslock.app.shield

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/**
 * Android's equivalent of the desktop blocked-app popup: same content
 * (name, reason, live countdown), same mellow styling (no red, no alarm
 * iconography), but stays up while the blocked app is foregrounded rather
 * than auto-dismissing — the user backing out returns to the blocked app's
 * task, which BlockAccessibilityService immediately re-shields. There is no
 * dismiss-and-unblock affordance; the back/home buttons just leave this
 * screen, they don't end the session.
 */
class ShieldActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val blockedPackage = intent.getStringExtra(EXTRA_BLOCKED_PACKAGE) ?: "This app"
        val endsAt = intent.getLongExtra(EXTRA_ENDS_AT, System.currentTimeMillis())
        setContent {
            MaterialTheme {
                ShieldScreen(blockedPackage, endsAt)
            }
        }
    }

    companion object {
        const val EXTRA_BLOCKED_PACKAGE = "blockedPackage"
        const val EXTRA_ENDS_AT = "endsAt"
    }
}

@Composable
private fun ShieldScreen(blockedPackage: String, endsAt: Long) {
    var remainingMs by mutableLongStateOf((endsAt - System.currentTimeMillis()).coerceAtLeast(0))
    LaunchedEffect(endsAt) {
        while (remainingMs > 0) {
            delay(1000)
            remainingMs = (endsAt - System.currentTimeMillis()).coerceAtLeast(0)
        }
    }
    val totalSeconds = remainingMs / 1000
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60

    Surface(
        modifier = Modifier
            .fillMaxSize()
            .background(Brush.verticalGradient(listOf(Color(0xFFE8EDFB), Color(0xFFECE7FB), Color(0xFFFBF6EE)))),
        color = Color.Transparent,
    ) {
        Column(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(blockedPackage, style = MaterialTheme.typography.headlineSmall, color = Color(0xFF2C2B3A))
            Text("Focus session in progress", color = Color(0xFF6B6A80), modifier = Modifier.padding(top = 8.dp))
            Text(
                String.format("%02d:%02d remaining", minutes, seconds),
                style = MaterialTheme.typography.titleLarge,
                color = Color(0xFF7C8CF8),
                modifier = Modifier.padding(top = 24.dp),
            )
        }
    }
}
