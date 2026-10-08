package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.USERS
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
        val name = displayName.trim()
        require(UserService.NICKNAME_PATTERN.matches(nick)) { "Přihlašovací jméno musí mít 3–64 znaků (písmena, číslice, . _ - @)" }
        require(name.isNotEmpty()) { "Jméno a příjmení je povinné" }

        val password = UserService.generatePassword()
        val hash = PasswordService.hash(password)
        // The audit lock is taken before the block runs, so two runs at once cannot both see "no administrator".
        AuditService.auditedTransaction(
            actor = null,
            action = "user.bootstrap_admin",
            entityType = "user",
            entityId = nick,
        ) { tx ->
            check(!tx.fetchExists(USERS, USERS.ISADMIN.eq(true).and(USERS.ISACTIVE.eq(true)).and(USERS.DELETEDAT.isNull))) {
                "An active administrator already exists. Create further users in the application, or reset a password with 'reset-password'."
            }
            check(!tx.fetchExists(USERS, USERS.NICKNAME.eq(nick))) { "A user named '$nick' already exists." }
            val now = OffsetDateTime.now()
            tx.insertInto(USERS)
                .set(USERS.NICKNAME, nick)
                .set(USERS.DISPLAYNAME, name)
                .set(USERS.PASSWORDHASH, hash)
                .set(USERS.ROLE, DbRole.valueOf(Role.BOSS.name))
                .set(USERS.ISADMIN, true)
                .set(USERS.ISACTIVE, true)
                .set(USERS.MUSTCHANGEPWD, true)
                .set(USERS.CREATEDAT, now)
                .set(USERS.UPDATEDAT, now)
                .execute()
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
        AuditService.auditedTransaction(
            actor = null,
            action = "user.password_reset",
            entityType = "user",
            entityId = nick,
        ) { tx ->
            val id = tx.update(USERS)
                .set(USERS.PASSWORDHASH, hash)
                .setNull(USERS.PASSWORDCHANGEDAT) // a temporary password is not one the user chose
                .set(USERS.MUSTCHANGEPWD, true)
                .set(USERS.UPDATEDAT, OffsetDateTime.now())
                .where(USERS.NICKNAME.eq(nick).and(USERS.ISACTIVE.eq(true)).and(USERS.DELETEDAT.isNull))
                .returning(USERS.ID)
                .fetchOne()
                ?.get(USERS.ID)
                ?: throw IllegalStateException("No active user named '$nick'.")
            SessionService.revokeAllForUser(tx, id)
            // The usual reason for a reset is that nobody can log in any more: lift a login lockout of the account too.
            RateLimiter.clear(tx, RateLimiter.Rules.LOGIN_USER, UserService.loginKey(nick))
        }
        return Result(nick, password)
    }
}
