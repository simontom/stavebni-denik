package cz.stavebni.denik.domain

import kotlinx.serialization.Serializable
import java.util.UUID

@Serializable
data class SessionUser(
    val id: UUID,
    val nickname: String,
    val displayName: String,
    val role: Role,
    val isAdmin: Boolean,
    val mustChangePwd: Boolean,
    val sessionId: UUID,
)
