package cz.stavebni.denik.domain

class ForbiddenException(val action: Action) : RuntimeException("Forbidden: $action")
class UnauthenticatedException : RuntimeException("Unauthenticated")

fun can(user: SessionUser, action: Action, resource: Resource = Resource()): Boolean {
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

        // Project
        Action.ProjectCreate,
        Action.ProjectUpdate,
        Action.ProjectDelete,
        Action.ProjectMemberManage,
        Action.ProjectListAll -> user.role == Role.BOSS

        // Reports
        Action.ReportCreate -> user.role == Role.BOSS || (user.role == Role.WORKER && resource.isMember)
        Action.ReportUpdate -> {
            if (resource.isLocked) return false
            if (user.role == Role.BOSS && resource.isMember) return true
            if (user.role == Role.WORKER && resource.isMember && resource.authorId == user.id) return true
            false
        }
        Action.ReportSign -> user.role == Role.BOSS && resource.isMember
        Action.ReportAcknowledge -> user.role == Role.INSPECTOR && resource.isMember
        Action.ReportAddendumCreate -> (user.role == Role.BOSS || user.role == Role.WORKER) && resource.isMember

        // Photos, remarks, materials
        Action.PhotoUpload -> (user.role == Role.BOSS || user.role == Role.WORKER) && resource.isMember && !resource.isLocked
        Action.PhotoDelete -> user.role == Role.BOSS && resource.isMember && !resource.isLocked
        Action.RemarkCreate -> (user.role == Role.BOSS || user.role == Role.WORKER || user.role == Role.INSPECTOR || user.role == Role.INVESTOR) && resource.isMember
        Action.MaterialCreate -> (user.role == Role.BOSS || user.role == Role.WORKER) && resource.isMember && !resource.isLocked
        Action.MaterialResolve -> (user.role == Role.BOSS || user.role == Role.WORKER) && resource.isMember

        // Visits
        Action.VisitCreate -> (user.role == Role.BOSS || user.role == Role.WORKER || user.role == Role.INSPECTOR) && resource.isMember
        Action.VisitDelete -> {
            if (user.role == Role.BOSS && resource.isMember) return true
            if (user.role == Role.WORKER && resource.isMember && resource.authorId == user.id) return true
            false
        }
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
