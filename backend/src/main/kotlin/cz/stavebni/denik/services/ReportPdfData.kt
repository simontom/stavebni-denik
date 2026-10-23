package cz.stavebni.denik.services

import kotlinx.serialization.Serializable

/**
 * What the fixed template (`pdf/report.typ`) shows. Everything user-controlled travels in here as data, never in the
 * template. The fields are in the order the document shows them, one section after the other; a section is built by one
 * function of [PdfExportService], so a later change touches one section. Part A comes from [PartASnapshot]: for an entry
 * signed in format 3 from the snapshot stored with it (the identification as it stood on the day of signing), otherwise from
 * the project as it stands when the PDF is made.
 *
 * Every text that people read is already formatted here: dates as `28. 9. 2026`, times in Prague time with the zone
 * (see CzechFormat). The template only lays out.
 */
@Serializable
internal data class ReportPdfData(
    // ---- the page: title, footer and watermark ----------------------------------------------------------------------
    val projectName: String,
    val address: String,
    /** The day of the entry as people write it (`28. 9. 2026`) and its weekday (`pondělí`). */
    val date: String,
    val weekday: String,
    /** Null while the entry is a draft: the number is given at signing (decision D11). */
    val sequenceNumber: Int?,
    /** A draft (false) carries a watermark on every page and has no signature block. */
    val isSigned: Boolean,

    // ---- part A: the identification of the diary (příloha 12, part A) -----------------------------------------------
    /**
     * The identification, only what has a value. Signed in format 3 it is the identification as it stood on the day of signing
     * (part of the signature); a draft and an older entry print the project as it stands when the PDF is made.
     */
    val projectInfo: List<LabeledPdf> = emptyList(),
    /**
     * Says which of the two the identification is: as of the day of signing and part of the signature, or as of the day the
     * PDF is made and (for a signed entry) not part of the signature, with when the project was last changed if that was after
     * signing. For an entry whose stored snapshot is missing: that it cannot be verified.
     */
    val projectInfoNote: String = "",
    /** The firms of the subcontractors, one per line; empty when none were entered. */
    val subcontractors: String = "",
    /** The documents the diary refers to, one per line; empty when none were entered. */
    val supportingDocuments: String = "",
    /** The managers (role BOSS) of the project, with the scope of their authorisation and responsibility (příloha 12 A d)). */
    val managers: List<PartAPersonPdf> = emptyList(),
    /** The members of the supervision (role INSPECTOR), with their scope (A e)). */
    val supervisors: List<PartAPersonPdf> = emptyList(),
    /** The persons who may make entries, with their function (A f)). */
    val authorizedPersons: List<AuthorizedPersonPdf> = emptyList(),
    /** SHA-256 of the part A snapshot stored with the signature (format 3); empty otherwise. */
    val partASha256: String = "",
    /** The entry was signed in format 3 and its snapshot is missing or unreadable: the signature cannot be verified. */
    val partAMissing: Boolean = false,

    // ---- part B: the entry of the day -------------------------------------------------------------------------------
    // Everything the signature covers is here, so the printed entry says everything that was signed.
    /**
     * The name of the author of the entry as it was stored when the entry was made (the signature covers the author's id; the name
     * is printed, not signed).
     */
    val author: String = "",
    val isLateEntry: Boolean,
    val lateEntryReason: String,
    /** A construction inspection took place that day (the signature covers the flag). */
    val isControlDay: Boolean = false,
    /** The construction object (SO) the entry is about; empty when none was entered. */
    val constructionObj: String = "",
    /** The weather as readable text, or `Neuvedeno`. */
    val weather: String,
    /** The people on site by trade (the vyhláška asks for their names); empty when none were entered. */
    val workers: List<WorkerPdf> = emptyList(),
    val workDescription: String,
    /** Every field of [EntryDetails], in their fixed order, with the label of the vyhláška; the text is empty when nothing was entered. */
    val details: List<DetailPdf> = emptyList(),
    /** The photos of the entry (the files themselves are not in the PDF), oldest first. */
    val photos: List<PhotoPdf> = emptyList(),

    // ---- the signature (empty while the entry is a draft) -----------------------------------------------------------
    val entryId: String = "",
    /**
     * The format the entry was signed in (see ReportSignature); null for a draft. Format 1 is what was signed before hashes
     * existed, so a missing hash or audit row is explained as an old entry only there; from format 2 on it is a failure, as in
     * `ReportSignature.check`, and the PDF says so.
     */
    val signatureFormat: Int? = null,
    /** Who signed ("Name, ČKAIT 123"); the name and the number are cut when they are enormous, so the signature block has a known height. */
    val signedBy: String,
    /** When, in Prague time with the zone. */
    val signedAt: String,
    /** SHA-256 of the entry's content at signing (see ReportSignature); empty for an entry signed before hashes existed. */
    val signatureHash: String,
    /**
     * SHA-256 of the entry's `report.lock` row in the audit chain. That row's `after` snapshot holds the [signatureHash], so
     * it ties the printed entry to the chain. Not the head of the chain: that changes with every action and would tell every
     * reader how busy the whole company is. Empty when the entry has no such row (signed before the audit trail existed).
     */
    val auditRowHash: String = "",

    // ---- the handover of the site (příloha 12 B.2 a)): records of their own, after the end of the entry -----------------
    /**
     * The handover protocols that belong to this entry, oldest day first, at most [PdfExportService.MAX_HANDOVERS]. For a signed entry
     * the ones that had a signature when the entry was signed, with the signatures that existed then; for a draft all the current
     * ones, as they are. A protocol has its own two signatures and is not part of the signature of the entry.
     */
    val handovers: List<HandoverPdf> = emptyList(),
    /** Says which of the two it is, and that the protocols are not covered by the signature of the entry. */
    val handoversNote: String = "",
    /** Protocols that belong to the entry and are not printed, because the document prints at most [PdfExportService.MAX_HANDOVERS]. */
    val handoversLeftOut: Int = 0,

    // ---- after the signature: records of their own, not part of what the signature covers ---------------------------
    /** The addenda of a signed entry, oldest first. */
    val addenda: List<AddendumPdf> = emptyList(),
    /** The entries of other parties, oldest first. */
    val remarks: List<RemarkPdf> = emptyList(),
    /** Who took note of the signed entry ("Name, ČKAIT number (role)"), with the time, oldest first. */
    val acknowledgements: List<AcknowledgementPdf> = emptyList(),
)

@Serializable
internal data class LabeledPdf(val label: String, val value: String)

/** A person named in part A: the ČKAIT number is empty when there is none, the scope when none was stated. */
@Serializable
internal data class PartAPersonPdf(val name: String, val ckait: String, val scope: String, val siteManager: Boolean)

@Serializable
internal data class AuthorizedPersonPdf(val name: String, val company: String, val function: String)

@Serializable
internal data class WorkerPdf(val trade: String, val count: Int, val names: String)

@Serializable
internal data class DetailPdf(val label: String, val text: String)

/** A photo of the entry: who uploaded it (the name stored at upload), when (Prague time), and the SHA-256 of the stored file (empty when none was recorded). */
@Serializable
internal data class PhotoPdf(val uploadedBy: String, val at: String, val sha256: String)

/** [who] is the name and the ČKAIT number (if the person had one) as they were stored when the person took note, and the role. */
@Serializable
internal data class AcknowledgementPdf(val who: String, val at: String)

/** [author] is the name and the ČKAIT number (if any) as they were stored with the entry: of the manager who recorded it when it speaks for [onBehalfOf]. */
@Serializable
internal data class RemarkPdf(val author: String, val onBehalfOf: String, val at: String, val text: String)

/** [author] is the name and the ČKAIT number (if any) as they were stored with the addendum. */
@Serializable
internal data class AddendumPdf(val author: String, val at: String, val text: String)

/** One reading of a meter in a handover protocol. */
@Serializable
internal data class MeterPdf(val medium: String, val serialNumber: String, val state: String)

/**
 * One side's signature of a handover protocol as the signature stored it: [signedBy] is the name (cut when it is enormous, so the
 * block of the signatures has a known height), the role in the project and, for the contractor, the ČKAIT number; [at] is Prague time
 * with the zone; [signatureHash] the SHA-256 of the signature.
 */
@Serializable
internal data class HandoverSignaturePdf(val signedBy: String, val at: String, val signatureHash: String)

/**
 * A handover protocol (předání a převzetí staveniště) as the entry's document prints it. A side that has not signed is null. [state]
 * is the state at the moment the document describes: for a signed entry the one on the day it was signed.
 */
@Serializable
internal data class HandoverPdf(
    /** The day of the handover (`28. 9. 2026`). */
    val date: String,
    val type: String,
    val participants: String,
    /** Empty when there are none. */
    val notes: String,
    val meters: List<MeterPdf>,
    /** In words: nobody has signed, one side has, both have. */
    val state: String,
    /** SHA-256 of the content that the parties signed; empty while nobody has signed. */
    val contentHash: String,
    val contractor: HandoverSignaturePdf? = null,
    val client: HandoverSignaturePdf? = null,
)
