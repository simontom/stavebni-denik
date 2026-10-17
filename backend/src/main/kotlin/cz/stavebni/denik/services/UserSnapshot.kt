package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.records.UsersRecord
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement
import java.time.OffsetDateTime
import java.time.ZoneOffset

/**
 * What the audit log keeps of a user: who they are, what they may do and the state of the account, including the state of
 * its password as flags and timestamps (a temporary password has an expiry and no "chosen" time, a chosen one the opposite).
 *
 * **Never a password, a hash or a token.** A field that could hold one must not be added; `UserAuditRowsTest` fails on a name
 * that looks like one and on any stored row that holds a secret.
 *
 * Timestamps are text (UTC): a snapshot goes through `jsonb`, which would not keep the exact form of a number, and the hash
 * chain covers it (see `AuditHash`).
 */
@Serializable
internal data class UserSnapshot(
    val id: String,
    val nickname: String,
    val displayName: String,
    val role: String,
    val isAdmin: Boolean,
    val isActive: Boolean,
    val deletedAt: String?,
    val ckaitNumber: String?,
    val mustChangePwd: Boolean,
    val passwordChangedAt: String?,
    val passwordExpiresAt: String?,
)

/** The user as stored in [this] row (read it after the change for the "after" of an audit row, before it for the "before"). */
internal fun UsersRecord.toSnapshot(): JsonElement = Json.encodeToJsonElement(
    UserSnapshot.serializer(),
    UserSnapshot(
        id = id.toString(),
        nickname = nickname ?: "",
        displayName = displayname ?: "",
        role = role?.name ?: "",
        isAdmin = isadmin ?: false,
        isActive = isactive ?: false,
        deletedAt = deletedat.utcText(),
        ckaitNumber = ckaitnumber,
        mustChangePwd = mustchangepwd ?: false,
        passwordChangedAt = passwordchangedat.utcText(),
        passwordExpiresAt = passwordexpiresat.utcText(),
    ),
)

private fun OffsetDateTime?.utcText(): String? = this?.withOffsetSameInstant(ZoneOffset.UTC)?.toString()
