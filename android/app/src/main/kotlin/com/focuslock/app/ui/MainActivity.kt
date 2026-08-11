package com.focuslock.app.ui

import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.focuslock.app.admin.FocusLockDeviceAdminReceiver
import com.focuslock.app.data.AppDatabase
import com.focuslock.app.service.FocusLockForegroundService
import kotlinx.coroutines.delay

/**
 * Lean Compose UI mirroring the desktop's visual language (mellow gradient,
 * soft cards) but not its full page-by-page fidelity — Home (start +
 * running countdown), Log (session table), Devices (pairing — see the
 * "pairing not implemented" note below). Not run on a device/emulator; see
 * DECISIONS.md.
 */
class MainActivity : ComponentActivity() {
    private val vpnPermissionLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {}
    private val notifPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestOnboardingPermissions()
        setContent {
            MaterialTheme { AppRoot(::startFocusSession) }
        }
    }

    private fun requestOnboardingPermissions() {
        VpnService.prepare(this)?.let { vpnPermissionLauncher.launch(it) }
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            notifPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
        val pm = getSystemService(PowerManager::class.java)
        if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
            try {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = android.net.Uri.parse("package:$packageName")
                })
            } catch (e: Exception) {
                // OEM-specific settings screen variance — user can grant manually from Settings.
            }
        }
        if (!FocusLockDeviceAdminReceiver.isActive(this)) {
            startActivity(Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, FocusLockDeviceAdminReceiver.componentName(this@MainActivity))
                putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Focus Lock uses device admin to prevent uninstalling itself to bypass an active session.")
            })
        }
        startForegroundService(Intent(this, FocusLockForegroundService::class.java))
    }

    private fun startFocusSession(durationS: Int, categories: Set<String>, label: String?) {
        val intent = Intent(this, FocusLockForegroundService::class.java).apply {
            action = FocusLockForegroundService.ACTION_START_SESSION
            putExtra(FocusLockForegroundService.EXTRA_DURATION_S, durationS)
            putExtra(FocusLockForegroundService.EXTRA_CATEGORIES, categories.toTypedArray())
            putExtra(FocusLockForegroundService.EXTRA_LABEL, label)
        }
        ContextCompat.startForegroundService(this, intent)
    }
}

private val NAV_ITEMS = listOf("Home", "Log", "Devices", "Settings")

@Composable
fun AppRoot(onStart: (Int, Set<String>, String?) -> Unit) {
    var tab by remember { mutableIntStateOf(0) }
    Surface(
        modifier = Modifier
            .fillMaxSize()
            .background(Brush.verticalGradient(listOf(Color(0xFFE8EDFB), Color(0xFFECE7FB), Color(0xFFFBF6EE)))),
        color = Color.Transparent,
    ) {
        Scaffold(
            containerColor = Color.Transparent,
            bottomBar = {
                NavigationBar(containerColor = Color.White.copy(alpha = 0.7f)) {
                    NAV_ITEMS.forEachIndexed { i, label ->
                        NavigationBarItem(selected = tab == i, onClick = { tab = i }, label = { Text(label) }, icon = {})
                    }
                }
            },
        ) { padding ->
            Box(Modifier.padding(padding).padding(16.dp)) {
                when (tab) {
                    0 -> HomeTab(onStart)
                    1 -> LogTab()
                    2 -> DevicesTab()
                    else -> SettingsTab()
                }
            }
        }
    }
}

@Composable
fun HomeTab(onStart: (Int, Set<String>, String?) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var presetS by remember { mutableStateOf<Int?>(25 * 60) }
    var label by remember { mutableStateOf("") }
    var categories by remember { mutableStateOf(setOf("social", "games")) }
    var running by remember { mutableStateOf(false) }
    var remainingS by remember { mutableLongStateOf(0L) }

    LaunchedEffect(Unit) {
        while (true) {
            val db = AppDatabase.get(context)
            val active = db.activeSessionDao().get()
            running = active != null && System.currentTimeMillis() < active.endsAt
            remainingS = if (active != null) ((active.endsAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0) else 0
            delay(1000)
        }
    }

    if (running) {
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Text("${remainingS / 60}:${(remainingS % 60).toString().padStart(2, '0')}", style = MaterialTheme.typography.displayMedium)
            Text("Focus session in progress — no pause or cancel is available.", color = Color(0xFF6B6A80))
        }
        return
    }

    Column(Modifier.fillMaxSize()) {
        Text("Home", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(16.dp))
        Text("Duration")
        Row {
            listOf("25m" to 25 * 60, "50m" to 50 * 60, "90m" to 90 * 60).forEach { (l, s) ->
                FilterChip(selected = presetS == s, onClick = { presetS = s }, label = { Text(l) }, modifier = Modifier.padding(end = 8.dp))
            }
        }
        Spacer(Modifier.height(16.dp))
        Text("Categories")
        Row {
            listOf("social", "games", "video", "news").forEach { c ->
                FilterChip(
                    selected = categories.contains(c), onClick = {
                        categories = if (categories.contains(c)) categories - c else categories + c
                    }, label = { Text(c) }, modifier = Modifier.padding(end = 8.dp),
                )
            }
        }
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(value = label, onValueChange = { label = it }, label = { Text("What are you working on? (optional)") })
        Spacer(Modifier.height(24.dp))
        Button(onClick = { onStart(presetS ?: 0, categories, label.ifBlank { null }) }, enabled = (presetS ?: 0) > 0 && categories.isNotEmpty()) {
            Text("Start")
        }
    }
}

@Composable
fun LogTab() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val sessions = remember { AppDatabase.get(context).sessionDao().listBetween(0, Long.MAX_VALUE) }
    Column {
        Text("Log", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(16.dp))
        if (sessions.isEmpty()) {
            Text("No sessions logged yet.", color = Color(0xFF6B6A80))
        } else {
            LazyColumn {
                items(sessions) { s ->
                    Text("${java.util.Date(s.startedAt)} — ${(s.actualDurationS ?: s.plannedDurationS) / 60}m — ${s.label ?: ""}")
                }
            }
        }
    }
}

@Composable
fun DevicesTab() {
    var code by remember { mutableStateOf("") }
    Column {
        Text("Devices", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(16.dp))
        Text(
            "Pairing (SPAKE2 key exchange) is not implemented in this build — see DECISIONS.md. " +
                "The UI below is wired but the underlying crypto call is a placeholder.",
            color = Color(0xFF6B6A80),
        )
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(value = code, onValueChange = { code = it }, label = { Text("Enter 6-digit code") })
        Spacer(Modifier.height(8.dp))
        Button(onClick = { /* PairingManager.joinerStart(code) — not implemented */ }) { Text("Join") }
    }
}

@Composable
fun SettingsTab() {
    Column {
        Text("Settings", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(16.dp))
        Text("Category toggles, relay URL, and about info live in the same settings table the service reads — see data/Daos.kt.", color = Color(0xFF6B6A80))
    }
}
