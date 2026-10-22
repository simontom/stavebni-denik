package cz.stavebni.denik.domain

import kotlinx.serialization.Serializable

/**
 * The two parties of a site handover protocol (předání a převzetí staveniště, příloha 12 B.2 a)). Each signs once: the
 * protocol is complete when both have.
 *
 * Which side a person signs for follows from the role they hold **in the project** (never from the global role of the
 * account): a manager is the contractor's person, an investor or the technical supervision is the client's. A worker is a
 * party to neither, and neither is somebody who is not a member, an administrator included.
 */
@Serializable
enum class HandoverSide {
    /** Zhotovitel: signed by a member whose role in the project is BOSS (who also holds a ČKAIT number, decision D2). */
    CONTRACTOR,

    /** Stavebník (investor), or the technical supervision that acts for him: signed by an INVESTOR or an INSPECTOR. */
    CLIENT;

    companion object {
        /** The side a person with [role] in the project signs for, or null for a role that signs for none (a worker, a non-member). */
        fun of(role: Role?): HandoverSide? = when (role) {
            Role.BOSS -> CONTRACTOR
            Role.INVESTOR, Role.INSPECTOR -> CLIENT
            Role.WORKER, null -> null
        }
    }
}
