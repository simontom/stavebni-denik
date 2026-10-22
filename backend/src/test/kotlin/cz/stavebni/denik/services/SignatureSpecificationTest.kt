package cz.stavebni.denik.services

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The specification of signature format 3 (`PROJECT.md`, "What a signature covers") must not drift from the code. Three things
 * say the same: the golden vectors (`signature-format-3-vectors.json`, read by [SignatureFormat3VectorsTest]), the Python
 * reference verifier that anybody who holds the stored values can run (`scripts/signature/verify-signature-format-3.py`,
 * standard library only), and the block of it that `PROJECT.md` quotes. Python is needed here; CI sets `REQUIRE_PYTHON=1`,
 * which turns a missing Python into a failure instead of a skip.
 */
class SignatureSpecificationTest {

    /** The repository root: the directory with PROJECT.md, above the working directory of the test. */
    private val root: File = generateSequence(File(".").absoluteFile.normalize()) { it.parentFile }.first { File(it, "PROJECT.md").isFile }

    private val script = File(root, "scripts/signature/verify-signature-format-3.py")
    private val vectors = File(root, "backend/src/test/resources/signature-format-3-vectors.json")

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
        val section = between(File(root, "PROJECT.md").readText(), "<!-- signature-format-3-spec:begin -->", "<!-- signature-format-3-spec:end -->")
        // The block sits in a nested list of the document, so every line is indented by the same amount.
        val inTheDocument = section.trimIndent().removePrefix("```python").removeSuffix("```").trim()

        assertEquals(inTheScript, inTheDocument, "PROJECT.md quotes the specification block of scripts/signature/verify-signature-format-3.py verbatim")
    }

    /** Runs what the block of PROJECT.md says on the vectors, with nothing of the script around it: the block has to stand on its own. */
    private val driver = """
        import json, sys
        namespace = {}
        with open(sys.argv[1], encoding="utf-8") as f:
            exec(compile(f.read(), sys.argv[1], "exec"), namespace)
        with open(sys.argv[2], encoding="utf-8") as f:
            vectors = json.load(f)
        problems = []
        for case in vectors["weatherCases"]:
            if namespace["weather_text"](case["weather"]) != case["text"]:
                problems.append("weather")
        for name, case in vectors["partA"].items():
            text = namespace["canonical"](case["partA"])
            if text != case["text"] or namespace["sha256_hex"](text) != case["sha256"]:
                problems.append("part A " + name)
        for name, case in vectors["entries"].items():
            part_a = vectors["partA"][case["partA"]]["text"]
            if namespace["signature_hash"](case["entry"], part_a) != case["signatureHash"]:
                problems.append("entry " + name)
        print("OK" if not problems else "FAILED " + ", ".join(problems))
        sys.exit(1 if problems else 0)
    """.trimIndent()

    @Test
    fun `the block that PROJECT-md quotes is complete, so extracted as it stands and run it reproduces the golden vectors`() {
        val python = pythonCommand()
        if (python == null) {
            if (System.getenv("REQUIRE_PYTHON") == "1") fail<Unit>("REQUIRE_PYTHON=1, but no Python was found")
            assumeTrue(false, "no Python on this machine")
            return
        }
        val lines = File(root, "PROJECT.md").readText().replace("\r\n", "\n").lines()
        val from = lines.indexOfFirst { it.contains("<!-- signature-format-3-spec:begin -->") }
        val to = lines.indexOfFirst { it.contains("<!-- signature-format-3-spec:end -->") }
        assertTrue(from >= 0 && to > from)
        val block = lines.subList(from + 1, to).joinToString("\n").trimIndent().removePrefix("```python").removeSuffix("```").trim() + "\n"
        val dir = java.nio.file.Files.createTempDirectory("signature-spec-").toFile()
        try {
            val spec = File(dir, "spec.py").apply { writeText(block, Charsets.UTF_8) }
            val run = File(dir, "run.py").apply { writeText(driver, Charsets.UTF_8) }
            // Isolated mode (-I): nothing of the environment, the user's site or the working directory is imported.
            val process = ProcessBuilder(python + "-I" + run.absolutePath + spec.absolutePath + vectors.absolutePath).redirectErrorStream(true).start()
            val output = process.inputStream.readBytes().toString(Charsets.UTF_8)
            assertTrue(process.waitFor(60, TimeUnit.SECONDS), "the block did not finish")
            assertEquals(0, process.exitValue(), output)
            assertEquals("OK", output.trim())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `the specification names the same keys as the code`() {
        val specification = script.readText()
        for (key in ReportSignature.FORMAT_3_DETAIL_KEYS) assertTrue(specification.contains("\"$key\""), "the verifier does not know the field '$key'")
        for (key in ReportSignature.FORMAT_3_COLUMNS.map { it.name } + listOf("format", "photos", "details", "partASha256")) {
            assertTrue(specification.contains("\"$key\""), "the verifier does not know the key '$key'")
        }
        for (key in PartASnapshot.IDENTIFICATION_KEYS) {
            assertTrue(File(root, "PROJECT.md").readText().contains(key), "PROJECT.md does not name the key '$key' of the identification")
        }
    }
}
