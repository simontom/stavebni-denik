package cz.stavebni.denik.domain

import java.util.UUID

data class Resource(
    val isMember: Boolean = false,
    val isLocked: Boolean = false,
    val authorId: UUID? = null,
)
