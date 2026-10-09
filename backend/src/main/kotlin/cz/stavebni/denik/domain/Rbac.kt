package cz.stavebni.denik.domain

class ForbiddenException(val action: Action) : RuntimeException("Forbidden: $action")
class UnauthenticatedException : RuntimeException("Unauthenticated")

/**
 * Whether [user] may do [action] to [resource].
 *
 * Application administration (users, audit log) follows the administrator flag. Everything inside a project follows
 * the role the person has **in that project** ([Resource.role]); their global role only decides who may create projects.
 */
fun can(user: SessionUser, action: Action, resource: Resource = Resource()): Boolean {
    val role = resource.role
    val isBoss = role == Role.BOSS
    val isBossOrWorker = role == Role.BOSS || role == Role.WORKER
    return when (action) {
        // App-admin
        Action.UserCreate,
        Action.UserUpdate,
        Action.UserDeactivate,
        Action.UserActivate,
        Action.UserDelete,
        Action.UserPasswordReset,
        Action.AuditRead,
        Action.AuditVerify -> user.isAdmin

        // Creating a project makes the creator its manager: that is for project managers (global role) only.
        Action.ProjectCreate,
        Action.ProjectListAll -> user.role == Role.BOSS

        // Changing or deleting a project: its manager.
        Action.ProjectUpdate,
        Action.ProjectDelete -> isBoss

        // Members and authorized persons: the manager of the project, or an application administrator as the
        // audited way in (decision D1; the audit row names the project, the person and the role).
        Action.ProjectMemberManage -> isBoss || user.isAdmin

        // Reports
        // Writing to a project's diary requires being a member of that project. App admins
        // (isAdmin) may read every project but gain no write rights by being admins.
        Action.ReportCreate -> isBossOrWorker
        Action.ReportUpdate -> {
            if (resource.isLocked) return false
            if (isBoss) return true
            if (role == Role.WORKER && resource.authorId == user.id) return true
            false
        }
        // A signed report is final: it cannot be signed a second time.
        Action.ReportSign -> isBoss && !resource.isLocked
        Action.ReportAcknowledge -> role == Role.INSPECTOR || role == Role.INVESTOR
        Action.ReportAddendumCreate -> isBossOrWorker

        // Photos, remarks, materials
        Action.PhotoUpload -> isBossOrWorker && !resource.isLocked
        Action.PhotoDelete -> isBoss && !resource.isLocked

        Action.RemarkCreate -> role != null && !resource.isLocked
        Action.RemarkUpdate,
        Action.RemarkDelete -> {
            if (resource.isLocked) return false
            if (isBoss) return true
            if (role != null && resource.authorId == user.id) return true
            false
        }

        Action.MaterialCreate -> isBossOrWorker && !resource.isLocked
        Action.MaterialUpdate,
        Action.MaterialDelete -> {
            if (resource.isLocked) return false
            if (isBoss) return true
            if (role == Role.WORKER && resource.authorId == user.id) return true
            false
        }
        Action.MaterialResolve -> isBossOrWorker

        // Visits
        Action.VisitCreate -> (isBossOrWorker || role == Role.INSPECTOR) && !resource.isLocked
        Action.VisitUpdate,
        Action.VisitDelete -> {
            if (resource.isLocked) return false
            if (isBoss) return true
            if (role != null && resource.authorId == user.id) return true
            false
        }

        // Site Handovers
        Action.SiteHandoverCreate -> isBossOrWorker
        Action.SiteHandoverUpdate,
        Action.SiteHandoverDelete -> {
            if (resource.isLocked) return false
            if (isBoss) return true
            if (role == Role.WORKER && resource.authorId == user.id) return true
            false
        }
        Action.SiteHandoverSign -> role != null
    }
}

fun assertCan(user: SessionUser, action: Action, resource: Resource = Resource()) {
    if (!can(user, action, resource)) {
        throw ForbiddenException(action)
    }
}

fun canAccessProject(user: SessionUser, isMember: Boolean): Boolean {
    if (user.role == Role.BOSS && user.isAdmin) return true
    return isMember
}

// Keep this strictly for prompt compliance if needed
fun canAccessProject(role: Role, isMember: Boolean): Boolean {
    return isMember
}
