package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UUIDSerializer
import cz.stavebni.denik.jooq.tables.references.NOTIFICATIONS
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import org.jooq.JSONB
import org.jooq.impl.DSL
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import java.time.OffsetDateTime
import java.util.UUID

@Serializable
data class NotificationDto(
    @Serializable(with = UUIDSerializer::class) val id: UUID,
    @Serializable(with = UUIDSerializer::class) val recipientId: UUID,
    val title: String,
    val content: String,
    val readAt: String?
)

@Serializable
data class NotificationPayload(
    val title: String,
    val content: String
)

object NotificationService {
    private val json = Json { encodeDefaults = true }

    suspend fun createNotification(tx: DSLContext, recipientId: UUID, title: String, content: String) {
        val payload = NotificationPayload(title, content)
        val payloadJson = JSONB.jsonb(json.encodeToString(payload))
        
        tx.insertInto(NOTIFICATIONS)
            .set(NOTIFICATIONS.ID, DSL.field("uuidv7()", UUID::class.java))
            .set(NOTIFICATIONS.RECIPIENTID, recipientId)
            .set(NOTIFICATIONS.KIND, "GENERAL")
            .set(NOTIFICATIONS.PAYLOAD, payloadJson)
            .execute()
    }

    suspend fun listUnread(tx: DSLContext, userId: UUID): List<NotificationDto> {
        return tx.selectFrom(NOTIFICATIONS)
            .where(NOTIFICATIONS.RECIPIENTID.eq(userId))
            .and(NOTIFICATIONS.READAT.isNull)
            .fetch()
            .map { record ->
                val payloadStr = record.get(NOTIFICATIONS.PAYLOAD)?.data() ?: "{}"
                val payload = try {
                    json.decodeFromString<NotificationPayload>(payloadStr)
                } catch (e: Exception) {
                    NotificationPayload("Unknown", "Unknown")
                }
                
                NotificationDto(
                    id = record.get(NOTIFICATIONS.ID)!!,
                    recipientId = record.get(NOTIFICATIONS.RECIPIENTID)!!,
                    title = payload.title,
                    content = payload.content,
                    readAt = record.get(NOTIFICATIONS.READAT)?.toString()
                )
            }
    }

    suspend fun markAsRead(user: SessionUser, notificationId: UUID) {
        val tx = DatabaseFactory.dsl
        
        val notification = tx.selectFrom(NOTIFICATIONS)
            .where(NOTIFICATIONS.ID.eq(notificationId))
            .fetchOne() ?: throw IllegalArgumentException("Notification not found")
            
        if (notification.get(NOTIFICATIONS.RECIPIENTID) != user.id) {
            throw IllegalArgumentException("Not authorized")
        }

        AuditService.auditedTransaction(
            actor = user,
            action = "notification.read",
            entityType = "notification",
            entityId = notificationId.toString()
        ) { t ->
            t.update(NOTIFICATIONS)
                .set(NOTIFICATIONS.READAT, OffsetDateTime.now())
                .where(NOTIFICATIONS.ID.eq(notificationId))
                .execute()
        }
    }
}
