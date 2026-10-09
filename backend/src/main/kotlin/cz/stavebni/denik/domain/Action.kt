package cz.stavebni.denik.domain

sealed interface Action {
    // User admin
    data object UserCreate : Action
    data object UserUpdate : Action
    data object UserDeactivate : Action
    data object UserActivate : Action
    data object UserDelete : Action
    data object UserPasswordReset : Action
    data object AuditRead : Action
    data object AuditVerify : Action
    
    // Projects
    data object ProjectCreate : Action
    data object ProjectUpdate : Action
    data object ProjectDelete : Action
    data object ProjectMemberManage : Action
    data object ProjectListAll : Action
    
    // Reports
    data object ReportCreate : Action
    data object ReportUpdate : Action
    data object ReportSign : Action
    data object ReportAcknowledge : Action
    data object ReportAddendumCreate : Action
    
    // Photos and entries of other parties
    data object PhotoUpload : Action
    data object PhotoDelete : Action
    /** An entry of another party (technical supervision, the client, an authority via the manager). Entries are never changed or deleted. */
    data object RemarkCreate : Action
    
    // Site Handovers
    data object SiteHandoverCreate : Action
    data object SiteHandoverUpdate : Action
    data object SiteHandoverDelete : Action
    data object SiteHandoverSign : Action
}
