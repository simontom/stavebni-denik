package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

class NotificationServiceTest : BaseIntegrationTest() {

    @Test
    fun `create, list unread, and mark as read notifications`() {
        runBlocking {
        val user1 = createTestUser(role = Role.WORKER)
        val user2 = createTestUser(role = Role.BOSS)

        // 1. Create notification for user1
        NotificationService.createNotification(dsl, user1.id, "Novy ukol", "Byl vam pridelen novy denni zaznam.")
        NotificationService.createNotification(dsl, user1.id, "Upozorneni", "Nezapomente na podpis.")

        // 2. List unread for user1
        val unreadUser1 = NotificationService.listUnread(dsl, user1.id)
        assertEquals(2, unreadUser1.size)
        assertTrue(unreadUser1.any { it.title == "Novy ukol" })
        assertTrue(unreadUser1.any { it.title == "Upozorneni" })

        // User2 should have 0 unread
        val unreadUser2 = NotificationService.listUnread(dsl, user2.id)
        assertEquals(0, unreadUser2.size)

        // 3. Mark one as read
        val targetNotification = unreadUser1.first { it.title == "Novy ukol" }
        NotificationService.markAsRead(user1, targetNotification.id)

        // Verify only 1 remains unread
        val remaining = NotificationService.listUnread(dsl, user1.id)
        assertEquals(1, remaining.size)
        assertEquals("Upozorneni", remaining[0].title)

        // 4. Unauthorized markAsRead attempt by user2 -> throws IllegalArgumentException
        val otherNotification = remaining[0]
        assertThrows<IllegalArgumentException> {
            runBlocking {
                NotificationService.markAsRead(user2, otherNotification.id)
            }
        }
    }
}
}



