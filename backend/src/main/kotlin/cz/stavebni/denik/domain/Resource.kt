package cz.stavebni.denik.domain

import java.util.UUID

/**
 * What a permission decision needs to know about the thing being acted on.
 *
 * [role] is the role the person holds **in the project** the thing belongs to (`project_members.role`), or null when
 * they are not a member. What someone may do in a project follows that role, not their global one: the same person can
 * be the site manager of one project and an ordinary worker in another. An application administrator who is not a
 * member has no role here, and so no write rights.
 */
data class Resource(
    val role: Role? = null,
    val isLocked: Boolean = false,
    val authorId: UUID? = null,
) {
    val isMember: Boolean get() = role != null
}
