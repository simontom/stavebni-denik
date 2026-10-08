package cz.stavebni.denik.services

import cz.stavebni.denik.config.AppConfig
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID

/**
 * Where uploaded photos live on disk.
 *
 * The database stores a *key* relative to the uploads directory (`photos/<uuid>_orig.jpg`), never an
 * absolute path: absolute paths leak the server layout and would trust whatever a row says.
 * Resolving a key checks its exact shape and that the resulting file lies inside the uploads
 * directory, so a corrupted or manipulated row can never point at another file.
 */
object PhotoStorage {
    private val KEY = Regex("^photos/[0-9a-f-]{36}_(orig|thumb)[.]jpg$")

    private fun baseDir(): Path = AppConfig.uploadsDir.toAbsolutePath().normalize()

    fun keyFor(fileId: UUID, thumbnail: Boolean): String =
        "photos/${fileId}_${if (thumbnail) "thumb" else "orig"}.jpg"

    /** Writes [bytes] under [key], creating the directory if needed. Only keys made by [keyFor] are accepted. */
    fun write(key: String, bytes: ByteArray) {
        val target = resolveForWrite(key)
        Files.createDirectories(target.parent)
        Files.write(target, bytes)
    }

    /** Removes a file that was written but whose database row was never created. Never throws. */
    fun deleteQuietly(key: String) {
        try {
            Files.deleteIfExists(resolveForWrite(key))
        } catch (e: Exception) {
            // best effort: an orphaned file is harmless, a failing cleanup must not hide the real error
        }
    }

    /** The file behind a stored key, or null when the key is not valid, escapes the uploads directory, or the file is gone. */
    fun resolve(key: String): Path? {
        if (!KEY.matches(key)) return null
        val base = baseDir()
        val file = base.resolve(key).normalize()
        return file.takeIf { it.startsWith(base) && Files.isRegularFile(it) }
    }

    private fun resolveForWrite(key: String): Path {
        require(KEY.matches(key)) { "Invalid photo key" }
        val base = baseDir()
        return base.resolve(key).normalize().also { require(it.startsWith(base)) { "Invalid photo key" } }
    }
}
