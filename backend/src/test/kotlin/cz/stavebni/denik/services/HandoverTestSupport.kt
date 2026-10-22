package cz.stavebni.denik.services

import cz.stavebni.denik.domain.HandoverSide
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.SessionUser
import java.time.OffsetDateTime
import java.util.UUID

/** What a client sends to make a protocol. */
internal fun handoverInput(
    type: String = "PROTOCOL",
    date: String = "2026-09-28",
    participants: String = "Novák",
    meterStates: List<MeterState>? = null,
    notes: String? = null,
    expectedUpdatedAt: String? = null,
) = SiteHandoverInput(type, date, participants, meterStates, notes, expectedUpdatedAt)

/** What a client sends to change a stored protocol: what it shows now, with [changes] on it, and the version it was looking at. */
internal fun SiteHandoverDto.asInput(
    type: String = this.type,
    date: String = this.date,
    participants: String = this.participants,
    meterStates: List<MeterState>? = this.meterStates,
    notes: String? = this.notes,
    expectedUpdatedAt: String? = this.updatedAt,
) = SiteHandoverInput(type, date, participants, meterStates, notes, expectedUpdatedAt)

internal val SiteHandoverDto.uuid: UUID get() = UUID.fromString(id!!)

/** [user] signs the protocol as it stands in [handover] (its version is the one they looked at). */
internal suspend fun signHandover(user: SessionUser, handover: SiteHandoverDto, side: HandoverSide? = null): SiteHandoverDto =
    SiteHandoverService.signHandover(user, handover.uuid, SignHandoverRequest(side, OffsetDateTime.parse(handover.updatedAt!!)))
