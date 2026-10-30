package cz.stavebni.denik.domain

import kotlinx.serialization.json.Json

/**
 * The configured `Json` instances of the application, one per configuration in use. A `Json` is built once and reused: creating
 * one per call is slow (and Kotlin warns about it), and one place says which settings the code relies on.
 *
 * Not here on purpose: the instances that produce what is hashed or signed (`AuditHash`, `PartASnapshot`, `ReportSignature` and
 * the other canonical JSON builders). Those formats are frozen, so their settings stay next to them, where a change is seen as a
 * change of the format.
 */
object AppJson {
    /** The kotlinx default: an unknown key is an error. For input that has to be exactly what the application writes (the list of workers). */
    val strict: Json = Json.Default

    /** An unknown key is skipped, a default value is not written. For reading what other parties or older rows hold, and for writing values that omit defaults. */
    val lenient: Json = Json { ignoreUnknownKeys = true }

    /** An unknown key is skipped, a default value is written too: the API bodies, the `jsonb` columns, the data the PDF template reads. */
    val api: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }
}
