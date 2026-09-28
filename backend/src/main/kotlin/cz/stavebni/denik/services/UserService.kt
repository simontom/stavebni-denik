package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.Role
import org.jooq.DSLContext
import java.util.UUID

object UserService {

    fun findUserByNickname(tx: DSLContext, nickname: String): SessionUser? {
        val record = tx.selectFrom(USERS)
            .where(USERS.NICKNAME.eq(nickname))
            .fetchOne() ?: return null

        return SessionUser(
            id = record.get(USERS.ID)!!,
            nickname = record.get(USERS.NICKNAME)!!,
            displayName = record.get(USERS.DISPLAYNAME)!!,
            role = cz.stavebni.denik.domain.Role.valueOf(record.get(USERS.ROLE)!!.name),
            isAdmin = record.get(USERS.ISADMIN)!!,
            mustChangePwd = record.get(USERS.MUSTCHANGEPWD)!!,
            sessionId = UUID.randomUUID()
        )
    }

    fun findPasswordHash(tx: DSLContext, nickname: String): String? {
        return tx.select(USERS.PASSWORDHASH)
            .from(USERS)
            .where(USERS.NICKNAME.eq(nickname))
            .fetchOneInto(String::class.java)
    }
}
