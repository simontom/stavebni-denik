package cz.stavebni.denik.services

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The specification of the audit hash (`PROJECT.md`, "Audit log") must not drift from the code. Three things say the same:
 * the golden vectors (`audit-hash-v2-vectors.json`, read by [AuditHashTest]), the Python reference verifier that a recipient of
 * an export can run (`scripts/audit/verify-audit-hash.py`, standard library only), and the block of it that `PROJECT.md` quotes.
 * Python is needed here; CI sets `REQUIRE_PYTHON=1`, which turns a missing Python into a failure instead of a skip.
 */
class AuditSpecificationTest {

    /** The repository root: the directory with PROJECT.md, above the working directory of the test. */
    private val root: File = generateSequence(File(".").absoluteFile.normalize()) { it.parentFile }.first { File(it, "PROJECT.md").isFile }

    private val script = File(root, "scripts/audit/verify-audit-hash.py")
    private val vectors = File(root, "backend/src/test/resources/audit-hash-v2-vectors.json")

    private fun pythonCommand(): List<String>? =
        listOf(listOf("python3"), listOf("python"), listOf("py", "-3")).firstOrNull { candidate ->
            runCatching {
                val process = ProcessBuilder(candidate + "--version").redirectErrorStream(true).start()
                process.inputStream.readBytes()
                process.waitFor(20, TimeUnit.SECONDS) && process.exitValue() == 0
            }.getOrDefault(false)
        }

    @Test
    fun `the Python reference verifier, written from the specification, reproduces the golden vectors that the Kotlin code is tested against`() {
        val python = pythonCommand()
        if (python == null) {
            if (System.getenv("REQUIRE_PYTHON") == "1") fail<Unit>("REQUIRE_PYTHON=1, but no Python was found")
            assumeTrue(false, "no Python on this machine")
            return
        }
        val process = ProcessBuilder(python + script.absolutePath + "vectors" + vectors.absolutePath).redirectErrorStream(true).start()
        val output = process.inputStream.readBytes().toString(Charsets.UTF_8)
        assertTrue(process.waitFor(60, TimeUnit.SECONDS), "the verifier did not finish")
        assertEquals(0, process.exitValue(), output)
        assertEquals("OK", output.trim())
    }

    @Test
    fun `the code that PROJECT-md quotes as the specification is the code of the reference verifier`() {
        fun between(text: String, begin: String, end: String): String {
            val lines = text.replace("\r\n", "\n").lines()
            val from = lines.indexOfFirst { it.contains(begin) }
            val to = lines.indexOfFirst { it.contains(end) }
            assertTrue(from >= 0 && to > from, "'$begin' ... '$end' not found")
            return lines.subList(from + 1, to).joinToString("\n")
        }

        val inTheScript = between(script.readText(), "# --- specification begin", "# --- specification end").trim()
        val section = between(File(root, "PROJECT.md").readText(), "<!-- audit-hash-spec:begin -->", "<!-- audit-hash-spec:end -->")
        // The block sits in a nested list of the document, so every line is indented by the same amount.
        val inTheDocument = section.trimIndent().removePrefix("```python").removeSuffix("```").trim()

        assertEquals(inTheScript, inTheDocument, "PROJECT.md quotes the specification block of scripts/audit/verify-audit-hash.py verbatim")
    }

    @Test
    fun `the documentation names the same tags and the same vectors as the code`() {
        val document = File(root, "PROJECT.md").readText()
        for (needle in listOf("stavebni-denik/audit-payload", "stavebni-denik/audit-row", "00 00 00 00")) {
            assertTrue(document.contains(needle), "PROJECT.md does not mention '$needle'")
        }
        // The two tags are the ones the Kotlin code hashes (and that the golden vectors pin).
        val hash = File(root, "backend/src/main/kotlin/cz/stavebni/denik/services/AuditHash.kt").readText()
        assertTrue(hash.contains("\"stavebni-denik/audit-payload\"") && hash.contains("\"stavebni-denik/audit-row\""))
    }
}
