package cz.stavebni.denik.services

import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.jooq.tables.references.USERS
import org.jooq.DSLContext
import java.util.UUID

/**
 * Who a person is **as their account says it at this moment**: the display name, and the ČKAIT number if the account has one.
 *
 * A record of the diary that names its author stores this in the same insert, in its own columns, and never reads the account
 * again: the author of an entry, the uploader of a photo, and whoever wrote an addendum or an entry of another party or took note
 * of a signed entry (backlog B9). Renaming the user, or correcting or clearing their number, therefore changes nothing that was
 * written before; the page, the PDF and the audit row of the write all show the same values. (The signer of an entry and of a
 * handover protocol are frozen the same way, by the signature itself: `signerName` and `signerCkaitNumber`.)
 *
 * It is read inside the audited transaction. Every change of a user takes the same audit lock as every other write of the diary
 * ([AuditService.auditedWrite]), so the account cannot change between this read and the insert that stores it.
 */
internal class AccountIdentity(val name: String, val ckaitNumber: String?) {
    companion object {
        /** The account of [userId] now: the name trimmed, the number trimmed, or null when there is none (a blank number is none). */
        fun of(tx: DSLContext, userId: UUID): AccountIdentity {
            val account = tx.select(USERS.DISPLAYNAME, USERS.CKAITNUMBER).from(USERS).where(USERS.ID.eq(userId)).fetchOne()
            // A name is required of every account, so this is a safety net: a record that names nobody is no record of who wrote it.
            val name = account?.get(USERS.DISPLAYNAME)?.trim()
            if (name.isNullOrEmpty()) {
                throw ConflictException("Váš účet nemá vyplněné jméno. Požádejte administrátora, aby je doplnil, a zkuste to znovu.")
            }
            return AccountIdentity(name, account.get(USERS.CKAITNUMBER)?.trim()?.takeIf { it.isNotEmpty() })
        }
    }
}
