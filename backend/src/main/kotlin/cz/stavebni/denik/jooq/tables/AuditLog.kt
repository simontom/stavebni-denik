package cz.stavebni.denik.jooq.tables

import org.jooq.Field
import org.jooq.JSONB
import org.jooq.Name
import org.jooq.Record
import org.jooq.Table
import org.jooq.TableField
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType
import org.jooq.impl.TableImpl
import java.util.UUID

class AuditLog(
    alias: Name,
    aliased: Table<Record>?,
    parameters: Array<Field<*>>?
) : TableImpl<Record>(alias, DSL.schema("public"), aliased, parameters, DSL.comment("")) {

    companion object {
        val AUDIT_LOG = AuditLog(DSL.name("audit_log"), null, null)
    }

    val ID: TableField<Record, Long> = createField(DSL.name("id"), SQLDataType.BIGINT.nullable(false).identity(true), this, "")
    val ACTOR_ID: TableField<Record, String> = createField(DSL.name("actor_id"), SQLDataType.VARCHAR, this, "")
    val ACTION: TableField<Record, String> = createField(DSL.name("action"), SQLDataType.VARCHAR.nullable(false), this, "")
    val ENTITY_TYPE: TableField<Record, String> = createField(DSL.name("entity_type"), SQLDataType.VARCHAR.nullable(false), this, "")
    val ENTITY_ID: TableField<Record, String> = createField(DSL.name("entity_id"), SQLDataType.VARCHAR.nullable(false), this, "")
    val BEFORE: TableField<Record, JSONB> = createField(DSL.name("before"), SQLDataType.JSONB, this, "")
    val AFTER: TableField<Record, JSONB> = createField(DSL.name("after"), SQLDataType.JSONB, this, "")
    val IP: TableField<Record, String> = createField(DSL.name("ip"), SQLDataType.VARCHAR, this, "")
    val USER_AGENT: TableField<Record, String> = createField(DSL.name("user_agent"), SQLDataType.VARCHAR, this, "")
    val PREV_HASH: TableField<Record, String> = createField(DSL.name("prev_hash"), SQLDataType.VARCHAR.nullable(false), this, "")
    val ROW_HASH: TableField<Record, String> = createField(DSL.name("row_hash"), SQLDataType.VARCHAR.nullable(false), this, "")

    override fun `as`(alias: String): AuditLog = AuditLog(DSL.name(alias), this, null)
    override fun `as`(alias: Name): AuditLog = AuditLog(alias, this, null)
}
