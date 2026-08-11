package com.focuslock.app.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update

@Dao
interface SessionDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insert(session: SessionEntity)

    @Query("UPDATE sessions SET endedAt = :endedAt, actualDurationS = :actualDurationS, completed = 1 WHERE id = :id")
    fun complete(id: String, endedAt: Long, actualDurationS: Int)

    @Query("SELECT * FROM sessions WHERE startedAt >= :sinceMs AND startedAt < :untilMs ORDER BY startedAt ASC")
    fun listBetween(sinceMs: Long, untilMs: Long): List<SessionEntity>
}

@Dao
interface SettingDao {
    @Query("SELECT value FROM settings WHERE `key` = :key")
    fun get(key: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun set(setting: SettingEntity)
}

@Dao
interface DeviceDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(device: DeviceEntity)

    @Query("SELECT * FROM devices ORDER BY lastSeen DESC")
    fun listAll(): List<DeviceEntity>
}

@Dao
interface ActiveSessionDao {
    @Query("SELECT * FROM active_session WHERE id = 1")
    fun get(): ActiveSessionEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun set(row: ActiveSessionEntity)

    @Query("DELETE FROM active_session WHERE id = 1")
    fun clear()
}
