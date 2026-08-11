package com.focuslock.app.data

import androidx.room.Entity
import androidx.room.PrimaryKey

/** Mirrors the `sessions` table shape used by desktop/relay — see DECISIONS.md schema notes. */
@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey val id: String,
    val startedAt: Long,
    val endedAt: Long?,
    val plannedDurationS: Int,
    val actualDurationS: Int?,
    val label: String?,
    val completed: Boolean,
    val originDevice: String,
)

@Entity(tableName = "settings")
data class SettingEntity(
    @PrimaryKey val key: String,
    val value: String,
)

@Entity(tableName = "devices")
data class DeviceEntity(
    @PrimaryKey val id: String,
    val name: String,
    val platform: String,
    val lastSeen: Long,
    val pubkey: String,
)

/** The crash-recovery / dead-man's-switch row. Single row, id always 1. */
@Entity(tableName = "active_session")
data class ActiveSessionEntity(
    @PrimaryKey val id: Int = 1,
    val sessionId: String,
    val endsAt: Long,
    val startedAt: Long,
    val categoriesCsv: String,
    val label: String?,
    val originDevice: String,
)
