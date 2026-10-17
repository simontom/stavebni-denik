package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.USERS
import org.jooq.impl.DSL
import java.time.OffsetDateTime
import cz.stavebni.denik.jooq.enums.Role as DbRole

/**
 * The two things an operator has to be able to do before anyone can log in, or when nobody can any more:
 * create the first administrator, and give an administrator a new temporary password.
 *
 * Both run outside any request (see `cli/AdminCli.kt`), so there is no acting user: the audit rows have no
 * actor. Both produce a generated password that is shown once and has to be changed at the first login.
 */
object AdminBootstrapService {

    class Result(val nickname: String, val password: String)

    /** Creates an active administrator, but only while the system has none: after that, administrators are made in the application. */
    suspend fun createFirstAdmin(nickname: String, displayName: String): Result {
        val nick = nickname.trim()
        require(UserService.NICKNAME_PATTERN.matches(nick)) { "Přihlašovací jméno musí mít 3–64 znaků (písmena, číslice, . _ - @)" }
        val name = UserService.checkedDisplayName(displayName)

        val password = UserService.generatePassword()
        val hash = PasswordService.hash(password)
        // The audit lock is taken before the block runs, so two runs at once cannot both see "no administrator".
        AuditService.auditedWrite(actor = null, entityType = "user") { tx ->
            check(!tx.fetchExists(USERS, USERS.ISADMIN.eq(true).and(USERS.ISACTIVE.eq(true)).and(USERS.DELETEDAT.isNull))) {
                "An active administrator already exists. Create further users in the application, or reset a password with 'reset-password'."
            }
            check(!tx.fetchExists(USERS, DSL.lower(USERS.NICKNAME).eq(nick.lowercase()))) { "A user named '$nick' already exists." }
            val now = OffsetDateTime.now()
            val record = tx.insertInto(USERS)
                .set(USERS.NICKNAME, nick)
                .set(USERS.DISPLAYNAME, name)
                .set(USERS.PASSWORDHASH, hash)
                .set(USERS.ROLE, DbRole.valueOf(Role.BOSS.name))
                .set(USERS.ISADMIN, true)
                .set(USERS.ISACTIVE, true)
                .set(USERS.MUSTCHANGEPWD, true)
                .set(USERS.PASSWORDEXPIRESAT, now.plus(UserService.TEMPORARY_PASSWORD_LIFETIME))
                .set(USERS.CREATEDAT, now)
                .set(USERS.UPDATEDAT, now)
                .returning()
                .fetchOne()
                ?: throw IllegalStateException("The administrator could not be created.")
            AuditService.Audited(result = Unit, action = "user.bootstrap_admin", entityId = record.id.toString(), after = record.toSnapshot())
        }
        return Result(nick, password)
    }

    /**
     * New temporary password for an active account, e.g. the only administrator who is locked out.
     * Every session of the account ends, a login lockout of the account is lifted, and the password has to be
     * changed at the next login.
     */
    suspend fun resetPassword(nickname: String): Result {
        val nick = nickname.trim()
        val password = UserService.generatePassword()
        val hash = PasswordService.hash(password)
        AuditService.auditedWrite(actor = null, entityType = "user") { tx ->
            val existing = tx.selectFrom(USERS)
                .where(USERS.NICKNAME.eq(nick).and(USERS.ISACTIVE.eq(true)).and(USERS.DELETEDAT.isNull))
                .forUpdate()
                .fetchOne()
                ?: throw IllegalStateException("No active user named '$nick'.")
            val updated = UserService.issueTemporaryPassword(tx, existing, hash)
            SessionService.revokeAllForUser(tx, updated.id!!)
            // The usual reason for a reset is that nobody can log in any more: lift a login lockout of the account too.
            RateLimiter.clear(tx, RateLimiter.Rules.LOGIN_USER, UserService.loginKey(nick))
            AuditService.Audited(
                result = Unit,
                action = "user.password_reset",
                entityId = updated.id.toString(),
                before = existing.toSnapshot(),
                after = updated.toSnapshot(),
            )
        }
        return Result(nick, password)
    }
}
