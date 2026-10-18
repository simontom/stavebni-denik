package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.TooManyRequestsException
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.domain.can
import cz.stavebni.denik.jooq.tables.records.UsersRecord
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.util.Text
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import org.jooq.Record
import org.jooq.impl.DSL
import java.security.SecureRandom
import java.time.Duration
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
    /**
     * A notice for the administrator who has just saved this user, in the answer to the save only (null everywhere else): the
     * ČKAIT number of somebody who manages a project was changed or cleared. It is not stored and not part of the audit row.
     */
    val warning: String? = null,
)

/** Minimal user info for pickers (site manager, project members). */
@Serializable
data class UserOptionDto(
    val id: String,
    val nickname: String,
    val displayName: String,
    val role: String,
    /**
     * Whether the person holds a ČKAIT number, which a manager of a project and a site manager must (decision D2): a picker
     * offers only such people for those roles. The number itself is not in this list, it is personal data of the account.
     */
    val hasCkait: Boolean,
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

    /** The longest display name and ČKAIT number, counted after trimming; the text columns are bounded by nothing else. */
    const val MAX_DISPLAY_NAME_CHARS = 200
    const val MAX_CKAIT_CHARS = 50

    /** A display name as it is stored: trimmed, not empty, at most [MAX_DISPLAY_NAME_CHARS] characters. Anything wrong is a 400. */
    internal fun checkedDisplayName(value: String): String {
        val name = value.trim()
        require(name.isNotEmpty()) { "Jméno a příjmení je povinné" }
        return Text.checked(name, "Jméno a příjmení", MAX_DISPLAY_NAME_CHARS)
    }

    /** A ČKAIT number as it is stored: trimmed, null when blank, at most [MAX_CKAIT_CHARS] characters. */
    internal fun checkedCkaitNumber(value: String?): String? =
        value?.trim()?.ifEmpty { null }?.let { Text.checked(it, "Číslo ČKAIT", MAX_CKAIT_CHARS) }
    /** How long a generated password (new account, administrator reset) works if it is never used. */
    val TEMPORARY_PASSWORD_LIFETIME: Duration = Duration.ofDays(7)

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

    /**
     * Active users for pickers (who to add to a project, who to name site manager). Available to administrators, to
     * people who may create projects (global role BOSS) and to anyone who manages at least one project.
     */
    fun listUserOptions(tx: DSLContext, actor: SessionUser): List<UserOptionDto> {
        val managesAProject = tx.fetchExists(
            PROJECT_MEMBERS,
            PROJECT_MEMBERS.USERID.eq(actor.id).and(PROJECT_MEMBERS.ROLE.eq(DbRole.BOSS))
        )
        if (!actor.isAdmin && !can(actor, Action.ProjectCreate) && !managesAProject) throw ForbiddenException(Action.ProjectMemberManage)
        return tx.select(USERS.ID, USERS.NICKNAME, USERS.DISPLAYNAME, USERS.ROLE, USERS.CKAITNUMBER)
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
                    hasCkait = !r.get(USERS.CKAITNUMBER).isNullOrBlank(),
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
        require(NICKNAME_PATTERN.matches(nickname)) {
            "Přihlašovací jméno musí mít 3–64 znaků (písmena, číslice, . _ - @)"
        }
        val displayName = checkedDisplayName(req.displayName)
        val ckaitNumber = checkedCkaitNumber(req.ckaitNumber)
        val role = parseRole(req.role)
        val password = generatePassword()
        val hash = PasswordService.hashAsync(password)

        // The audit row is written after the insert, in the same transaction: it names the user by id and holds what the user is.
        val created = AuditService.auditedWrite(actor, "user") { tx ->
            // "alice" and "Alice" would be look-alike accounts in a legal record, and share one login lockout.
            if (tx.fetchExists(USERS, DSL.lower(USERS.NICKNAME).eq(nickname.lowercase()))) {
                throw IllegalStateException("Uživatel s přihlašovacím jménem $nickname již existuje")
            }
            val now = OffsetDateTime.now()
            val record = tx.insertInto(USERS)
                .set(USERS.NICKNAME, nickname)
                .set(USERS.DISPLAYNAME, displayName)
                .set(USERS.PASSWORDHASH, hash)
                .set(USERS.ROLE, DbRole.valueOf(role.name))
                .set(USERS.ISADMIN, req.isAdmin)
                .set(USERS.ISACTIVE, true)
                .set(USERS.MUSTCHANGEPWD, true)
                .set(USERS.PASSWORDEXPIRESAT, now.plus(TEMPORARY_PASSWORD_LIFETIME))
                .set(USERS.CKAITNUMBER, ckaitNumber)
                .set(USERS.CREATEDBYID, actor.id)
                .set(USERS.CREATEDAT, now)
                .set(USERS.UPDATEDAT, now)
                .returning()
                .fetchOne()
                ?: throw IllegalStateException("Nepodařilo se vytvořit uživatele")
            AuditService.Audited(
                result = toDto(record),
                action = "user.create",
                entityId = record.id.toString(),
                after = record.toSnapshot(),
            )
        }
        return CreateUserResponse(user = created, initialPassword = password)
    }

    suspend fun updateUser(actor: SessionUser, id: UUID, req: UpdateUserRequest): UserDto {
        assertCan(actor, Action.UserUpdate)
        if (id == actor.id && req.isAdmin == false) {
            throw IllegalArgumentException("Nelze odebrat administrátorská práva sám sobě")
        }
        val role = req.role?.let { parseRole(it) }
        val displayName = req.displayName?.let { checkedDisplayName(it) }
        val ckaitNumber = checkedCkaitNumber(req.ckaitNumber) // null when blank: a blank number clears it, an absent one leaves it

        return AuditService.auditedWrite(actor, "user") { tx ->
            val existing = lockedUser(tx, id)
            // Whoever may edit users could otherwise make themselves a project manager (and then a member of any project).
            if (id == actor.id && role != null && existing.role?.name != role.name) {
                throw IllegalArgumentException("Nelze změnit vlastní roli")
            }
            // The number is the qualification to manage a project and to sign (decision D2, D1): an administrator who could give
            // themselves one would certify themselves, join any project as its manager and sign. The edit form sends the number
            // along with every edit, so only an actual change is refused.
            val ckaitChanged = req.ckaitNumber != null && ckaitNumber != existing.ckaitnumber?.trim()?.ifEmpty { null }
            if (id == actor.id && ckaitChanged) {
                throw ConflictException("Své vlastní číslo ČKAIT si administrátor měnit nemůže, jinak by si mohl kvalifikaci potvrdit sám. Požádejte jiného administrátora.")
            }
            if (req.isAdmin == false) requireAnotherActiveAdminIfTargetIsOne(tx, id)

            val update = tx.update(USERS).set(USERS.UPDATEDAT, OffsetDateTime.now())
            if (displayName != null) update.set(USERS.DISPLAYNAME, displayName)
            if (role != null) update.set(USERS.ROLE, DbRole.valueOf(role.name))
            if (req.isAdmin != null) update.set(USERS.ISADMIN, req.isAdmin)
            if (ckaitChanged) update.set(USERS.CKAITNUMBER, ckaitNumber)
            val updated = update.where(USERS.ID.eq(id).and(USERS.DELETEDAT.isNull))
                .returning()
                .fetchOne()
                ?: throw NotFoundException("Uživatel nenalezen")

            // New rights apply at once on the server; end the sessions so the user's own screen
            // (which remembers the role from login) does not keep showing the old ones. Only when they really changed:
            // fixing a display name must not log the person out.
            val rightsChanged = existing.role != updated.role || existing.isadmin != updated.isadmin
            if (rightsChanged) SessionService.revokeAllForUser(tx, id)
            AuditService.Audited(
                // A number may be changed or cleared (an authorisation can be revoked, a number mistyped), but the editor is told
                // when the person manages a project: signing reads the number at the moment of signing.
                result = toDto(updated).copy(warning = if (ckaitChanged) ckaitWarning(tx, id, cleared = ckaitNumber == null) else null),
                action = "user.update",
                entityId = id.toString(),
                before = existing.toSnapshot(),
                after = updated.toSnapshot(),
            )
        }
    }

    suspend fun setActive(actor: SessionUser, id: UUID, active: Boolean): UserDto {
        assertCan(actor, if (active) Action.UserActivate else Action.UserDeactivate)
        if (id == actor.id && !active) throw IllegalArgumentException("Nelze deaktivovat vlastní účet")

        return AuditService.auditedWrite(actor, "user") { tx ->
            val existing = lockedUser(tx, id)
            if (!active) {
                requireAnotherActiveAdminIfTargetIsOne(tx, id)
                requireNotSiteManager(tx, id, "deaktivovat")
            }

            val updated = tx.update(USERS)
                .set(USERS.ISACTIVE, active)
                .set(USERS.UPDATEDAT, OffsetDateTime.now())
                .where(USERS.ID.eq(id).and(USERS.DELETEDAT.isNull))
                .returning()
                .fetchOne()
                ?: throw NotFoundException("Uživatel nenalezen")

            // Reactivating an account must not bring back sessions from before it was deactivated.
            if (!active) SessionService.revokeAllForUser(tx, id)
            AuditService.Audited(
                result = toDto(updated),
                action = if (active) "user.activate" else "user.deactivate",
                entityId = id.toString(),
                before = existing.toSnapshot(),
                after = updated.toSnapshot(),
            )
        }
    }

    /** Soft delete: the row stays for referential integrity and audit history. */
    suspend fun deleteUser(actor: SessionUser, id: UUID) {
        assertCan(actor, Action.UserDelete)
        if (id == actor.id) throw IllegalArgumentException("Nelze smazat vlastní účet")

        AuditService.auditedWrite(actor, "user") { tx ->
            val existing = lockedUser(tx, id)
            requireAnotherActiveAdminIfTargetIsOne(tx, id)
            requireNotSiteManager(tx, id, "smazat")

            val now = OffsetDateTime.now()
            val updated = tx.update(USERS)
                .set(USERS.DELETEDAT, now)
                .set(USERS.ISACTIVE, false)
                .set(USERS.UPDATEDAT, now)
                .where(USERS.ID.eq(id).and(USERS.DELETEDAT.isNull))
                .returning()
                .fetchOne()
                ?: throw NotFoundException("Uživatel nenalezen")
            SessionService.revokeAllForUser(tx, id)
            AuditService.Audited(
                result = Unit,
                action = "user.delete",
                entityId = id.toString(),
                before = existing.toSnapshot(),
                after = updated.toSnapshot(),
            )
        }
    }

    /** The row of a user who is not deleted, locked for the rest of the transaction: the state an audit row records as "before". */
    internal fun lockedUser(tx: DSLContext, id: UUID): UsersRecord =
        tx.selectFrom(USERS)
            .where(USERS.ID.eq(id).and(USERS.DELETEDAT.isNull))
            .forUpdate()
            .fetchOne() ?: throw NotFoundException("Uživatel nenalezen")

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

    /** Projects that are not deleted, of which [userId] is the site manager (stavbyvedoucí), by name. */
    private fun projectsAsSiteManager(tx: DSLContext, userId: UUID): List<String> =
        tx.select(PROJECTS.NAME)
            .from(PROJECTS)
            .where(PROJECTS.SITEMANAGERID.eq(userId).and(PROJECTS.DELETEDAT.isNull))
            .orderBy(PROJECTS.NAME.asc(), PROJECTS.CREATEDAT.asc())
            .fetch(PROJECTS.NAME)
            .filterNotNull()

    /** Projects that are not deleted in which [userId] is a manager (BOSS) without being its site manager, by name. */
    private fun projectsAsOtherManager(tx: DSLContext, userId: UUID): List<String> =
        tx.select(PROJECTS.NAME)
            .from(PROJECT_MEMBERS)
            .join(PROJECTS).on(PROJECTS.ID.eq(PROJECT_MEMBERS.PROJECTID))
            .where(PROJECT_MEMBERS.USERID.eq(userId).and(PROJECT_MEMBERS.ROLE.eq(DbRole.BOSS)))
            .and(PROJECTS.DELETEDAT.isNull)
            .and(PROJECTS.SITEMANAGERID.ne(userId))
            .orderBy(PROJECTS.NAME.asc(), PROJECTS.CREATEDAT.asc())
            .fetch(PROJECTS.NAME)
            .filterNotNull()

    /** The names of projects for a message, quoted, at most [MAX_NAMED_PROJECTS] of them. */
    private fun namedProjects(names: List<String>): String {
        val shown = names.take(MAX_NAMED_PROJECTS).joinToString(", ") { "„$it“" }
        return if (names.size > MAX_NAMED_PROJECTS) "$shown a další (celkem ${names.size})" else shown
    }

    private const val MAX_NAMED_PROJECTS = 5

    /**
     * A site manager cannot be deactivated or deleted (decision D2): the diary of the project is signed by them, and a project
     * always has one. The administrator first has the manager of the project replace the site manager
     * (`PUT /projects/{id}/site-manager`); after that the user manages no project as its site manager. Called inside the
     * audited transaction, so the answer cannot change before the user is changed.
     */
    private fun requireNotSiteManager(tx: DSLContext, userId: UUID, verb: String) {
        val projects = projectsAsSiteManager(tx, userId)
        if (projects.isEmpty()) return
        val which = if (projects.size == 1) "projektu" else "projektů"
        throw ConflictException(
            "Uživatele nelze $verb: je stavbyvedoucím $which ${namedProjects(projects)}. " +
                "Nejdřív nechte vedoucího projektu určit jiného stavbyvedoucího („Změnit stavbyvedoucího“ na stránce projektu), pak to zopakujte."
        )
    }

    /**
     * The notice that goes with a saved change of a ČKAIT number ([cleared]: removed, otherwise replaced) when the person manages
     * a project: as its site manager or as another of its managers. Null when they manage none. The change itself is allowed:
     * an authorisation can be revoked or suspended and a number can be mistyped.
     */
    private fun ckaitWarning(tx: DSLContext, userId: UUID, cleared: Boolean): String? {
        val asSiteManager = projectsAsSiteManager(tx, userId)
        val asOtherManager = projectsAsOtherManager(tx, userId)
        if (asSiteManager.isEmpty() && asOtherManager.isEmpty()) return null
        val roles = listOfNotNull(
            asSiteManager.takeIf { it.isNotEmpty() }?.let { "stavbyvedoucím ${if (it.size == 1) "projektu" else "projektů"} ${namedProjects(it)}" },
            asOtherManager.takeIf { it.isNotEmpty() }?.let { "vedoucím (BOSS) ${if (it.size == 1) "projektu" else "projektů"} ${namedProjects(it)}" },
        ).joinToString(" a ")
        val what = if (cleared) "Číslo ČKAIT bylo odebráno" else "Číslo ČKAIT bylo změněno"
        val consequence = if (cleared) {
            "Bez čísla uživatel nemůže podepisovat záznamy těchto projektů. Doplňte číslo" +
                if (asSiteManager.isNotEmpty()) ", nebo nechte v projektu určit jiného stavbyvedoucího." else "."
        } else {
            "Číslo se čte při každém podpisu: zkontrolujte, že patří téže osobě."
        }
        return "$what, ale uživatel je $roles. $consequence"
    }

    /**
     * A user changes their own password. The current one has to be given (a stolen session alone is not
     * enough), wrong answers are rate limited, and the new one has to meet [PasswordPolicy]. Every other
     * session of the user ends; the calling session goes on and is no longer forced to change the password.
     */
    suspend fun changeOwnPassword(actor: SessionUser, request: ChangePasswordRequest) {
        val db = DatabaseFactory.dsl
        // The attempt is reserved before the password is looked at and given back when it was right, so wrong answers
        // that arrive at the same moment cannot all slip under the limit.
        val reservation = RateLimiter.reserve(db, listOf(RateLimiter.Rules.PASSWORD_CHANGE to actor.id.toString()))
        reservation.refusedFor?.let {
            throw TooManyRequestsException(it.seconds, "Příliš mnoho pokusů o změnu hesla. Zkuste to znovu za ${RateLimiter.describeWait(it)}.")
        }

        // A request that is refused before the current password is compared is not a guess: it does not count.
        val currentHash: String
        try {
            val issues = PasswordPolicy.issues(request.newPassword, actor.nickname)
            require(issues.isEmpty()) { issues.joinToString(" ") }
            require(!BreachedPasswordService.isBreached(request.newPassword)) {
                "Toto heslo se objevilo v uniklých databázích hesel. Zvolte jiné."
            }
            require(request.currentPassword.length <= PasswordPolicy.MAX_LENGTH) { "Stávající heslo není správné." }

            currentHash = db.select(USERS.PASSWORDHASH)
                .from(USERS)
                .where(USERS.ID.eq(actor.id).and(USERS.DELETEDAT.isNull))
                .fetchOne(USERS.PASSWORDHASH)
                ?: throw NotFoundException("Uživatel nenalezen")
        } catch (e: Exception) {
            RateLimiter.release(db, reservation)
            throw e
        }
        if (!PasswordService.verifyAsync(currentHash, request.currentPassword)) {
            // The reserved attempt stays: it was a wrong guess.
            throw IllegalArgumentException("Stávající heslo není správné.")
        }
        RateLimiter.release(db, reservation)
        require(request.newPassword != request.currentPassword) { "Nové heslo musí být jiné než stávající." }

        val newHash = PasswordService.hashAsync(request.newPassword)
        // The audit row shows the account before and after (the password as flags and times); neither password nor hash goes into it.
        AuditService.auditedWrite(actor, "user") { tx ->
            // The password was checked a moment ago, outside this transaction. If an administrator reset it (or the
            // user changed it elsewhere) in between, this change was made on the strength of a password that no
            // longer exists: it must not overwrite the newer one.
            val existing = lockedUser(tx, actor.id)
            if (existing.passwordhash != currentHash) {
                throw IllegalStateException("Heslo bylo mezitím změněno. Přihlaste se znovu a zkuste to znovu.")
            }
            val updated = tx.update(USERS)
                .set(USERS.PASSWORDHASH, newHash)
                .set(USERS.PASSWORDCHANGEDAT, OffsetDateTime.now())
                .setNull(USERS.PASSWORDEXPIRESAT)
                .set(USERS.MUSTCHANGEPWD, false)
                .set(USERS.UPDATEDAT, OffsetDateTime.now())
                .where(USERS.ID.eq(actor.id))
                .returning()
                .fetchOne()
                ?: throw NotFoundException("Uživatel nenalezen")
            SessionService.revokeOthersForUser(tx, actor.id, actor.sessionId)
            AuditService.Audited(
                result = Unit,
                action = "user.password_change",
                entityId = actor.id.toString(),
                before = existing.toSnapshot(),
                after = updated.toSnapshot(),
            )
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
        AuditService.auditedWrite(actor, "user") { tx ->
            val existing = lockedUser(tx, id)
            val updated = issueTemporaryPassword(tx, existing, hash)
            SessionService.revokeAllForUser(tx, id)
            RateLimiter.clear(tx, RateLimiter.Rules.LOGIN_USER, loginKey(updated.nickname!!))
            AuditService.Audited(
                result = Unit,
                action = "user.password_reset",
                entityId = id.toString(),
                before = existing.toSnapshot(),
                after = updated.toSnapshot(),
            )
        }
        return ResetPasswordResponse(initialPassword = password)
    }

    /**
     * Gives the (locked) user [existing] the temporary password with hash [hash]: it has to be changed at the next login and
     * expires after [TEMPORARY_PASSWORD_LIFETIME]. Shared by the administrator's reset and the operator's `reset-password`.
     */
    internal fun issueTemporaryPassword(tx: DSLContext, existing: UsersRecord, hash: String): UsersRecord =
        tx.update(USERS)
            .set(USERS.PASSWORDHASH, hash)
            .setNull(USERS.PASSWORDCHANGEDAT) // a temporary password is not one the user chose
            .set(USERS.PASSWORDEXPIRESAT, OffsetDateTime.now().plus(TEMPORARY_PASSWORD_LIFETIME))
            .set(USERS.MUSTCHANGEPWD, true)
            .set(USERS.UPDATEDAT, OffsetDateTime.now())
            .where(USERS.ID.eq(existing.id!!))
            .returning()
            .fetchOne()
            ?: throw NotFoundException("Uživatel nenalezen")

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
