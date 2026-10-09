package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.records.DailyReportsRecord
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import org.jooq.TableField

/**
 * The text fields of a daily entry that the vyhláška asks for besides the day's work and the people on site
 * (vyhláška 131/2024 Sb., příloha 12, part B). One list drives everything that touches them: what a request may mention,
 * the limits, what is stored, what the audit snapshot and the signature cover, and what the PDF prints, so a field cannot be
 * added to one place and forgotten in another.
 *
 * The wording of the labels is **provisional**: it was written from a summary of the annex, not from its official text, and
 * has to be checked against the Sbírka zákonů and confirmed with a lawyer (PROJECT.md, "What an entry says").
 */
object EntryDetails {
    class Field(val key: String, val label: String, val column: TableField<DailyReportsRecord, String?>)

    /** In the order they are shown. The keys are the API's and are part of what the signature covers: never rename one. */
    val FIELDS: List<Field> = listOf(
        Field("materials", "Dodávky a uskladnění materiálu a zařízení", DAILY_REPORTS.MATERIALSIN),
        Field("machinery", "Použité stroje a mechanizace", DAILY_REPORTS.MACHINERY),
        Field("testsAndChecks", "Zkoušky, měření a kontroly", DAILY_REPORTS.TESTSANDCHECKS),
        Field("safetyNotes", "Bezpečnost práce, ochrana životního prostředí a poučení", DAILY_REPORTS.SAFETYNOTES),
        Field("dustMeasures", "Opatření proti prašnosti", DAILY_REPORTS.DUSTMEASURES),
        Field("accessibilityMeasures", "Opatření pro zajištění přístupnosti", DAILY_REPORTS.ACCESSIBILITYMEASURES),
        Field("defects", "Závady a jejich odstranění", DAILY_REPORTS.DEFECTS),
        Field("otherNotes", "Ostatní zápisy", DAILY_REPORTS.OTHERNOTES),
    )

    private val byKey = FIELDS.associateBy { it.key }

    /** Longest text of one field. A day's work is described in a few paragraphs; more is a mistake or an attack. */
    const val MAX_CHARS = 5_000

    /**
     * What a request mentions, as it is stored: trimmed text, an empty value (or only blanks) becomes null, which clears the
     * field. A name that is not a field, or a text that is too long, is refused (400); nothing is silently dropped.
     * Only the mentioned fields are in the result.
     */
    fun validated(mentioned: Map<String, String>): Map<Field, String?> =
        mentioned.entries.associate { (key, text) ->
            val field = byKey[key] ?: throw IllegalArgumentException("Neznámé pole záznamu: '${key.take(40)}'")
            require(text.length <= MAX_CHARS) { "Pole '${field.label}' může mít nejvýše $MAX_CHARS znaků" }
            requireNoNul(text, "Pole '${field.label}'")
            field to text.trim().takeIf { it.isNotEmpty() }
        }

    /** PostgreSQL cannot store the NUL character in text; saying so is a 400, not an error from the database (a 500). */
    fun requireNoNul(text: String, what: String) {
        require(!text.contains('\u0000')) { "$what obsahuje nepovolený znak (NUL)" }
    }

    /** The stored value of every field of [record], in the order of [FIELDS]; null when it is empty. */
    fun valuesOf(record: DailyReportsRecord): List<Pair<Field, String?>> =
        FIELDS.map { it to record.get(it.column)?.takeIf { text -> text.isNotBlank() } }

    /** Only the fields that have a text, by key: what the API returns and the audit snapshot keeps. */
    fun filledOf(record: DailyReportsRecord): Map<String, String> =
        valuesOf(record).mapNotNull { (field, text) -> text?.let { field.key to it } }.toMap()
}
