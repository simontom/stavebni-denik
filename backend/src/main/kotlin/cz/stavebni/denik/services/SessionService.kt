package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.SESSIONS
import cz.stavebni.denik.jooq.tables.references.USERS
import org.jooq.DSLContext
import org.jooq.impl.DSL
import java.time.Duration
import java.time.OffsetDateTime
import java.util.UUID

/**
 * Server-side sessions.
 *
 * The JWT cookie only *names* a session (`sessionId`) and a user (`id`); it is not
 * trusted for anything else. Every request looks the session up and loads the user's
 * current state, so that
 *
 * - logging out, deactivating or deleting a user revokes access at once (not when the
 *   token happens to expire),
 * - a changed role or admin flag applies to the very next request,
 * - a token whose session was revoked, expired or never existed is worthless, even
 *   with a valid signature.
 */
object SessionService {

    /** A session lasts 12 hours from login (the same limit the legacy app used). */
    val LIFETIME: Duration = Duration.ofHours(12)

    class Created(val id: UUID, val expiresAt: OffsetDateTime)

    fun create(tx: DSLContext, userId: UUID): Created {
        val expiresAt = OffsetDateTime.now().plus(LIFETIME)
        val id = tx.insertInto(SESSIONS)
            .set(SESSIONS.USERID, userId)
            .set(SESSIONS.EXPIRESAT, expiresAt)
            .returning(SESSIONS.ID)
            .fetchOne()
            ?.get(SESSIONS.ID)
            ?: throw IllegalStateException("Session could not be created")
        return Created(id, expiresAt)
    }

    /**
     * The *current* user behind a session, or null when the session is unknown, belongs to
     * another user, is revoked or expired, or the user is deactivated or deleted.
     * Role, admin flag and the password-change flag come from the database, not from the token.
     */
    fun resolve(tx: DSLContext, sessionId: UUID, userId: UUID): SessionUser? {
        val row = tx.select(USERS.ID, USERS.NICKNAME, USERS.DISPLAYNAME, USERS.ROLE, USERS.ISADMIN, USERS.MUSTCHANGEPWD)
            .from(SESSIONS)
            .join(USERS).on(USERS.ID.eq(SESSIONS.USERID))
            .where(SESSIONS.ID.eq(sessionId))
            .and(SESSIONS.USERID.eq(userId))
            .and(SESSIONS.REVOKEDAT.isNull)
            .and(SESSIONS.EXPIRESAT.gt(DSL.currentOffsetDateTime()))
            .and(USERS.ISACTIVE.eq(true))
            .and(USERS.DELETEDAT.isNull)
            .fetchOne() ?: return null

        return SessionUser(
            id = row.get(USERS.ID)!!,
            nickname = row.get(USERS.NICKNAME)!!,
            displayName = row.get(USERS.DISPLAYNAME)!!,
            role = Role.valueOf(row.get(USERS.ROLE)!!.name),
            isAdmin = row.get(USERS.ISADMIN)!!,
            mustChangePwd = row.get(USERS.MUSTCHANGEPWD)!!,
            sessionId = sessionId,
        )
    }

    fun revoke(tx: DSLContext, sessionId: UUID) {
        tx.update(SESSIONS)
            .set(SESSIONS.REVOKEDAT, OffsetDateTime.now())
            .where(SESSIONS.ID.eq(sessionId).and(SESSIONS.REVOKEDAT.isNull))
            .execute()
    }

    /** Ends the user's other sessions but keeps [keepSessionId], e.g. after the user changed the password. */
    fun revokeOthersForUser(tx: DSLContext, userId: UUID, keepSessionId: UUID) {
        tx.update(SESSIONS)
            .set(SESSIONS.REVOKEDAT, OffsetDateTime.now())
            .where(SESSIONS.USERID.eq(userId).and(SESSIONS.ID.ne(keepSessionId)).and(SESSIONS.REVOKEDAT.isNull))
            .execute()
    }

    /** Ends every session of a user, e.g. when the account is deactivated or its rights change. */
    fun revokeAllForUser(tx: DSLContext, userId: UUID) {
        tx.update(SESSIONS)
            .set(SESSIONS.REVOKEDAT, OffsetDateTime.now())
            .where(SESSIONS.USERID.eq(userId).and(SESSIONS.REVOKEDAT.isNull))
            .execute()
    }
}
