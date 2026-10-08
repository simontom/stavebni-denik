package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.TooManyRequestsException
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import org.jooq.Record
import org.jooq.impl.DSL
import java.security.SecureRandom
import java.time.OffsetDateTime
import java.util.UUID
import cz.stavebni.denik.jooq.enums.Role as DbRole

@Serializable
data class UserDto(
    val id: String,
    val nickname: String,
    val displayName: String,
    val role: String,
    val isAdmin: Boolean,
    val isActive: Boolean,
    val mustChangePwd: Boolean,
    val ckaitNumber: String? = null,
    val createdAt: String? = null,
)

/** Minimal user info for pickers (site manager, project members). */
@Serializable
data class UserOptionDto(
    val id: String,
    val nickname: String,
    val displayName: String,
    val role: String,
)

@Serializable
data class CreateUserRequest(
    val nickname: String,
    val displayName: String,
    val role: String = Role.WORKER.name,
    val isAdmin: Boolean = false,
    val ckaitNumber: String? = null,
)

@Serializable
data class CreateUserResponse(
    val user: UserDto,
    /** Shown to the admin exactly once; only the Argon2id hash is stored. */
    val initialPassword: String,
)

@Serializable
data class UpdateUserRequest(
    val displayName: String? = null,
    val role: String? = null,
    val isAdmin: Boolean? = null,
    val ckaitNumber: String? = null,
)

@Serializable
data class ChangePasswordRequest(
    val currentPassword: String,
    val newPassword: String,
)

@Serializable
data class ResetPasswordResponse(
    /** Shown to the administrator exactly once; only the Argon2id hash is stored. */
    val initialPassword: String,
)

object UserService {

    internal val NICKNAME_PATTERN = Regex("^[A-Za-z0-9._@-]{3,64}$")
    private const val PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
    private val random = SecureRandom()

    /** Active, non-deleted user by nickname (used by login). */
    fun findUserByNickname(tx: DSLContext, nickname: String): SessionUser? {
        val record = tx.selectFrom(USERS)
            .where(USERS.NICKNAME.eq(nickname))
            .and(USERS.ISACTIVE.eq(true))
            .and(USERS.DELETEDAT.isNull)
            .fetchOne() ?: return null

        return SessionUser(
            id = record.get(USERS.ID)!!,
            nickname = record.get(USERS.NICKNAME)!!,
            displayName = record.get(USERS.DISPLAYNAME)!!,
            role = Role.valueOf(record.get(USERS.ROLE)!!.name),
            isAdmin = record.get(USERS.ISADMIN)!!,
            mustChangePwd = record.get(USERS.MUSTCHANGEPWD)!!,
            sessionId = UUID.randomUUID()
        )
    }

    /** Password hash of an active, non-deleted user. */
    fun findPasswordHash(tx: DSLContext, nickname: String): String? {
        return tx.select(USERS.PASSWORDHASH)
            .from(USERS)
            .where(USERS.NICKNAME.eq(nickname))
            .and(USERS.ISACTIVE.eq(true))
            .and(USERS.DELETEDAT.isNull)
            .fetchOneInto(String::class.java)
    }

    fun listUsers(tx: DSLContext, actor: SessionUser): List<UserDto> {
        assertCan(actor, Action.UserUpdate)
        return tx.selectFrom(USERS)
            .where(USERS.DELETEDAT.isNull)
            .orderBy(USERS.NICKNAME.asc())
            .fetch()
            .map { toDto(it) }
    }

    /** Active users for pickers; available to project managers (BOSS) and admins. */
    fun listUserOptions(tx: DSLContext, actor: SessionUser): List<UserOptionDto> {
        if (!actor.isAdmin) assertCan(actor, Action.ProjectMemberManage)
        return tx.select(USERS.ID, USERS.NICKNAME, USERS.DISPLAYNAME, USERS.ROLE)
            .from(USERS)
            .where(USERS.DELETEDAT.isNull)
            .and(USERS.ISACTIVE.eq(true))
            .orderBy(USERS.DISPLAYNAME.asc())
            .fetch()
            .map { r ->
                UserOptionDto(
                    id = r.get(USERS.ID).toString(),
                    nickname = r.get(USERS.NICKNAME)!!,
                    displayName = r.get(USERS.DISPLAYNAME)!!,
                    role = r.get(USERS.ROLE)!!.name,
                )
            }
    }

    fun getUser(tx: DSLContext, id: UUID): UserDto =
        tx.selectFrom(USERS)
            .where(USERS.ID.eq(id).and(USERS.DELETEDAT.isNull))
            .fetchOne()
            ?.let { toDto(it) }
            ?: throw NotFoundException("Uživatel nenalezen")

    suspend fun createUser(actor: SessionUser, req: CreateUserRequest): CreateUserResponse {
        assertCan(actor, Action.UserCreate)
        val nickname = req.nickname.trim()
        val displayName = req.displayName.trim()
        require(NICKNAME_PATTERN.matches(nickname)) {
            "Přihlašovací jméno musí mít 3–64 znaků (písmena, číslice, . _ - @)"
        }
        require(displayName.isNotEmpty()) { "Jméno a příjmení je povinné" }
        val role = parseRole(req.role)
        val password = generatePassword()
        val hash = PasswordService.hashAsync(password)

        val created = AuditService.auditedTransaction(
            actor = actor,
            action = "user.create",
            entityType = "user",
            entityId = nickname,
        ) { tx ->
            // "alice" and "Alice" would be look-alike accounts in a legal record, and share one login lockout.
            if (tx.fetchExists(USERS, DSL.lower(USERS.NICKNAME).eq(nickname.lowercase()))) {
                throw IllegalStateException("Uživatel s přihlašovacím jménem $nickname již existuje")
            }
            val now = OffsetDateTime.now()
            tx.insertInto(USERS)
                .set(USERS.NICKNAME, nickname)
                .set(USERS.DISPLAYNAME, displayName)
                .set(USERS.PASSWORDHASH, hash)
                .set(USERS.ROLE, DbRole.valueOf(role.name))
                .set(USERS.ISADMIN, req.isAdmin)
                .set(USERS.ISACTIVE, true)
                .set(USERS.MUSTCHANGEPWD, true)
                .set(USERS.CKAITNUMBER, req.ckaitNumber?.trim()?.ifEmpty { null })
                .set(USERS.CREATEDBYID, actor.id)
                .set(USERS.CREATEDAT, now)
                .set(USERS.UPDATEDAT, now)
                .returning()
                .fetchOne()
                ?.let { toDto(it) }
                ?: throw IllegalStateException("Nepodařilo se vytvořit uživatele")
        }
        return CreateUserResponse(user = created, initialPassword = password)
    }

    suspend fun updateUser(actor: SessionUser, id: UUID, req: UpdateUserRequest): UserDto {
        assertCan(actor, Action.UserUpdate)
        if (id == actor.id && req.isAdmin == false) {
            throw IllegalArgumentException("Nelze odebrat administrátorská práva sám sobě")
        }
        val role = req.role?.let { parseRole(it) }
        val displayName = req.displayName?.trim()
        if (displayName != null) require(displayName.isNotEmpty()) { "Jméno a příjmení je povinné" }

        return AuditService.auditedTransaction(
            actor = actor,
            action = "user.update",
            entityType = "user",
            entityId = id.toString(),
        ) { tx ->
            if (req.isAdmin == false) requireAnotherActiveAdminIfTargetIsOne(tx, id)

            val update = tx.update(USERS).set(USERS.UPDATEDAT, OffsetDateTime.now())
            if (displayName != null) update.set(USERS.DISPLAYNAME, displayName)
            if (role != null) update.set(USERS.ROLE, DbRole.valueOf(role.name))
            if (req.isAdmin != null) update.set(USERS.ISADMIN, req.isAdmin)
            if (req.ckaitNumber != null) update.set(USERS.CKAITNUMBER, req.ckaitNumber.trim().ifEmpty { null })
            val updated = update.where(USERS.ID.eq(id).and(USERS.DELETEDAT.isNull))
                .returning()
                .fetchOne()
                ?: throw NotFoundException("Uživatel nenalezen")

            // New rights apply at once on the server; end the sessions so the user's own screen
            // (which remembers the role from login) does not keep showing the old ones.
            if (role != null || req.isAdmin != null) SessionService.revokeAllForUser(tx, id)
            toDto(updated)
        }
    }

    suspend fun setActive(actor: SessionUser, id: UUID, active: Boolean): UserDto {
        assertCan(actor, if (active) Action.UserActivate else Action.UserDeactivate)
        if (id == actor.id && !active) throw IllegalArgumentException("Nelze deaktivovat vlastní účet")

        return AuditService.auditedTransaction(
            actor = actor,
            action = if (active) "user.activate" else "user.deactivate",
            entityType = "user",
            entityId = id.toString(),
        ) { tx ->
            if (!active) requireAnotherActiveAdminIfTargetIsOne(tx, id)

            val updated = tx.update(USERS)
                .set(USERS.ISACTIVE, active)
                .set(USERS.UPDATEDAT, OffsetDateTime.now())
                .where(USERS.ID.eq(id).and(USERS.DELETEDAT.isNull))
                .returning()
                .fetchOne()
                ?: throw NotFoundException("Uživatel nenalezen")

            // Reactivating an account must not bring back sessions from before it was deactivated.
            if (!active) SessionService.revokeAllForUser(tx, id)
            toDto(updated)
        }
    }

    /** Soft delete: the row stays for referential integrity and audit history. */
    suspend fun deleteUser(actor: SessionUser, id: UUID) {
        assertCan(actor, Action.UserDelete)
        if (id == actor.id) throw IllegalArgumentException("Nelze smazat vlastní účet")

        AuditService.auditedTransaction(
            actor = actor,
            action = "user.delete",
            entityType = "user",
            entityId = id.toString(),
        ) { tx ->
            requireAnotherActiveAdminIfTargetIsOne(tx, id)

            val now = OffsetDateTime.now()
            val updated = tx.update(USERS)
                .set(USERS.DELETEDAT, now)
                .set(USERS.ISACTIVE, false)
                .set(USERS.UPDATEDAT, now)
                .where(USERS.ID.eq(id).and(USERS.DELETEDAT.isNull))
                .execute()
            if (updated == 0) throw NotFoundException("Uživatel nenalezen")
            SessionService.revokeAllForUser(tx, id)
        }
    }

    /**
     * The application must always keep an administrator. Called inside the audited transaction
     * (which is serialised by the audit lock) before an admin is demoted, deactivated or deleted:
     * if the target is an active admin and nobody else is, the change is refused. The actor's own
     * `isAdmin` flag cannot be trusted here: it is the value from the start of the request.
     */
    private fun requireAnotherActiveAdminIfTargetIsOne(tx: DSLContext, targetId: UUID) {
        fun activeAdmins() = USERS.ISADMIN.eq(true).and(USERS.ISACTIVE.eq(true)).and(USERS.DELETEDAT.isNull)

        val targetIsActiveAdmin = tx.fetchExists(USERS, activeAdmins().and(USERS.ID.eq(targetId)))
        if (targetIsActiveAdmin && !tx.fetchExists(USERS, activeAdmins().and(USERS.ID.ne(targetId)))) {
            throw IllegalStateException("Musí zůstat alespoň jeden aktivní administrátor")
        }
    }

    /**
     * A user changes their own password. The current one has to be given (a stolen session alone is not
     * enough), wrong answers are rate limited, and the new one has to meet [PasswordPolicy]. Every other
     * session of the user ends; the calling session goes on and is no longer forced to change the password.
     */
    suspend fun changeOwnPassword(actor: SessionUser, request: ChangePasswordRequest) {
        val db = DatabaseFactory.dsl
        val key = actor.id.toString()
        RateLimiter.retryAfter(db, RateLimiter.Rules.PASSWORD_CHANGE, key)?.let {
            throw TooManyRequestsException(it.seconds, "Příliš mnoho pokusů o změnu hesla. Zkuste to znovu za ${RateLimiter.describeWait(it)}.")
        }

        val issues = PasswordPolicy.issues(request.newPassword)
        require(issues.isEmpty()) { issues.joinToString(" ") }
        require(!BreachedPasswordService.isBreached(request.newPassword)) {
            "Toto heslo se objevilo v uniklých databázích hesel. Zvolte jiné."
        }
        require(request.currentPassword.length <= PasswordPolicy.MAX_LENGTH) { "Stávající heslo není správné." }

        val currentHash = db.select(USERS.PASSWORDHASH)
            .from(USERS)
            .where(USERS.ID.eq(actor.id).and(USERS.DELETEDAT.isNull))
            .fetchOne(USERS.PASSWORDHASH)
            ?: throw NotFoundException("Uživatel nenalezen")
        if (!PasswordService.verifyAsync(currentHash, request.currentPassword)) {
            RateLimiter.recordFailure(db, RateLimiter.Rules.PASSWORD_CHANGE, key)
            throw IllegalArgumentException("Stávající heslo není správné.")
        }
        require(request.newPassword != request.currentPassword) { "Nové heslo musí být jiné než stávající." }

        val newHash = PasswordService.hashAsync(request.newPassword)
        // The audit row names the account and the action only; neither password nor hash goes into it.
        AuditService.auditedTransaction(
            actor = actor,
            action = "user.password_change",
            entityType = "user",
            entityId = actor.id.toString(),
        ) { tx ->
            tx.update(USERS)
                .set(USERS.PASSWORDHASH, newHash)
                .set(USERS.PASSWORDCHANGEDAT, OffsetDateTime.now())
                .set(USERS.MUSTCHANGEPWD, false)
                .set(USERS.UPDATEDAT, OffsetDateTime.now())
                .where(USERS.ID.eq(actor.id))
                .execute()
            SessionService.revokeOthersForUser(tx, actor.id, actor.sessionId)
        }
    }

    /**
     * An administrator sets a new generated password for another user. The user has to change it at the
     * next login, every session of theirs ends at once, and a login lockout of the account is lifted.
     * The password is shown to the administrator once and stored only as a hash.
     */
    suspend fun resetPassword(actor: SessionUser, id: UUID): ResetPasswordResponse {
        assertCan(actor, Action.UserPasswordReset)
        if (id == actor.id) throw IllegalArgumentException("Vlastní heslo změníte v nabídce Změnit heslo")

        val password = generatePassword()
        val hash = PasswordService.hashAsync(password)
        AuditService.auditedTransaction(
            actor = actor,
            action = "user.password_reset",
            entityType = "user",
            entityId = id.toString(),
        ) { tx ->
            val nickname = tx.update(USERS)
                .set(USERS.PASSWORDHASH, hash)
                .setNull(USERS.PASSWORDCHANGEDAT) // a temporary password is not one the user chose
                .set(USERS.MUSTCHANGEPWD, true)
                .set(USERS.UPDATEDAT, OffsetDateTime.now())
                .where(USERS.ID.eq(id).and(USERS.DELETEDAT.isNull))
                .returning(USERS.NICKNAME)
                .fetchOne()
                ?.get(USERS.NICKNAME)
                ?: throw NotFoundException("Uživatel nenalezen")
            SessionService.revokeAllForUser(tx, id)
            RateLimiter.clear(tx, RateLimiter.Rules.LOGIN_USER, loginKey(nickname))
        }
        return ResetPasswordResponse(initialPassword = password)
    }

    /** The key under which failed logins of an account name are counted. */
    fun loginKey(nickname: String): String = nickname.trim().lowercase().take(128)

    fun generatePassword(length: Int = 14): String =
        (1..length).map { PASSWORD_ALPHABET[random.nextInt(PASSWORD_ALPHABET.length)] }.joinToString("")

    private fun parseRole(value: String): Role =
        Role.entries.firstOrNull { it.name == value.trim().uppercase() }
            ?: throw IllegalArgumentException("Neznámá role: $value")

    private fun toDto(r: Record): UserDto = UserDto(
        id = r.get(USERS.ID).toString(),
        nickname = r.get(USERS.NICKNAME)!!,
        displayName = r.get(USERS.DISPLAYNAME)!!,
        role = r.get(USERS.ROLE)!!.name,
        isAdmin = r.get(USERS.ISADMIN) ?: false,
        isActive = r.get(USERS.ISACTIVE) ?: false,
        mustChangePwd = r.get(USERS.MUSTCHANGEPWD) ?: false,
        ckaitNumber = r.get(USERS.CKAITNUMBER),
        createdAt = r.get(USERS.CREATEDAT)?.toString(),
    )
}
