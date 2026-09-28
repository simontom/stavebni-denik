package cz.stavebni.denik.jooq.tables

import org.jooq.Field
import org.jooq.Name
import org.jooq.Record
import org.jooq.Table
import org.jooq.TableField
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType
import org.jooq.impl.TableImpl
import java.util.UUID

class Users(
    alias: Name,
    aliased: Table<Record>?,
    parameters: Array<Field<*>>?
) : TableImpl<Record>(alias, DSL.schema("public"), aliased, parameters, DSL.comment("")) {

    companion object {
        val USERS = Users(DSL.name("users"), null, null)
    }

    val ID: TableField<Record, UUID> = createField(DSL.name("id"), SQLDataType.UUID.nullable(false), this, "")
    val NICKNAME: TableField<Record, String> = createField(DSL.name("nickname"), SQLDataType.VARCHAR.nullable(false), this, "")
    val DISPLAY_NAME: TableField<Record, String> = createField(DSL.name("displayName"), SQLDataType.VARCHAR.nullable(false), this, "")
    val PASSWORD_HASH: TableField<Record, String> = createField(DSL.name("passwordHash"), SQLDataType.VARCHAR.nullable(false), this, "")
    val ROLE: TableField<Record, String> = createField(DSL.name("role"), SQLDataType.VARCHAR.nullable(false), this, "")
    val IS_ADMIN: TableField<Record, Boolean> = createField(DSL.name("isAdmin"), SQLDataType.BOOLEAN.nullable(false), this, "")
    val MUST_CHANGE_PWD: TableField<Record, Boolean> = createField(DSL.name("mustChangePwd"), SQLDataType.BOOLEAN.nullable(false), this, "")

    override fun `as`(alias: String): Users = Users(DSL.name(alias), this, null)
    override fun `as`(alias: Name): Users = Users(alias, this, null)
}
