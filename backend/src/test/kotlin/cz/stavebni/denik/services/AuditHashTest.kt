package cz.stavebni.denik.services

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.time.OffsetDateTime

class AuditHashTest {

    @Test
    fun `row hash is byte-compatible with the original TypeScript canonical scheme`() {
        // Golden value produced by src/server/audit-hash.ts (computeRowHash) for the same payload.
        val after = Json.parseToJsonElement("""{"b":1,"a":"x\"y\n\u0001č"}""")
        val hash = AuditHash.rowHash(
            action = "user.create",
            entityType = "user",
            entityId = "novy.delnik",
            actorId = "11111111-1111-1111-1111-111111111111",
            before = null,
            after = after,
            ip = null,
            userAgent = null,
            prevHash = AuditHash.GENESIS_HASH,
            ts = OffsetDateTime.parse("2026-09-30T12:34:56.789Z"),
        )
        assertEquals("c628aca1e82f81309993defd1fa6e497068be7704474704a9886297e3eb9eab2", hash)
    }

    @Test
    fun `timestamps are hashed in UTC with millisecond precision`() {
        assertEquals("2026-09-30T10:34:56.789Z", AuditHash.formatTs(OffsetDateTime.parse("2026-09-30T12:34:56.789+02:00")))
        assertEquals("2026-09-30T12:34:56.000Z", AuditHash.formatTs(OffsetDateTime.parse("2026-09-30T12:34:56Z")))
    }
}
