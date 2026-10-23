package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import org.apache.pdfbox.Loader
import org.apache.pdfbox.text.PDFTextStripper
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import java.text.Normalizer
import java.util.concurrent.TimeUnit

/**
 * The tests that run the real typst tool, so they prove that the fixed template compiles and what the printed document says. They
 * are skipped when typst is not installed; CI installs it and sets REQUIRE_TYPST=1, which turns "not installed" into a failure
 * instead of a skip. The helpers read the text of the PDF back, per page and per place on the page.
 */
abstract class RealTypstTestBase : BaseIntegrationTest() {

    @BeforeEach
    fun useRealTypst() {
        val installed = try {
            val process = ProcessBuilder("typst", "--version").redirectErrorStream(true).start()
            process.waitFor(20, TimeUnit.SECONDS) && process.exitValue() == 0
        } catch (e: Exception) {
            false
        }
        if (!installed) {
            if (System.getenv("REQUIRE_TYPST") == "1") fail<Unit>("typst is required (REQUIRE_TYPST=1) but is not installed")
            assumeTrue(false, "typst is not installed")
        }
        PdfExportService.compiler = ProcessTypstCompiler()
    }

    protected fun textOf(pdf: ByteArray): String =
        Loader.loadPDF(pdf).use { Normalizer.normalize(PDFTextStripper().getText(it), Normalizer.Form.NFC) }

    /** The text of every page, so a test can say on which page something is. */
    protected fun pagesOf(pdf: ByteArray): List<String> = Loader.loadPDF(pdf).use { document ->
        val stripper = PDFTextStripper()
        (1..document.numberOfPages).map { number ->
            stripper.startPage = number
            stripper.endPage = number
            Normalizer.normalize(stripper.getText(document), Normalizer.Form.NFC)
        }
    }

    /**
     * No white space at all, and no zero-width space (the template puts one into a very long word, so that it can break): a long hash,
     * a watermark or such a word may be broken over several lines of the extracted text.
     */
    protected fun squeezed(text: String): String = text.filterNot { it.isWhitespace() || it == '\u200b' }

    /** The furthest point to the right that any text of the document reaches, in points (a page is 595 wide, its margin is 57), and the letter that reaches it. */
    protected fun rightmostPoint(pdf: ByteArray): Pair<Float, String> = Loader.loadPDF(pdf).use { document ->
        var furthest = 0f
        var letter = ""
        val stripper = object : PDFTextStripper() {
            override fun writeString(text: String, textPositions: MutableList<org.apache.pdfbox.text.TextPosition>) {
                for (position in textPositions) {
                    // The space at the end of a line that fills the width is not text that can be seen to run over.
                    if (position.unicode.isBlank()) continue
                    val end = position.xDirAdj + position.widthDirAdj
                    if (end > furthest) {
                        furthest = end
                        letter = position.unicode + " in \"" + text.take(40) + "\" on page ${currentPageNo}"
                    }
                }
            }
        }
        stripper.getText(document)
        furthest to letter
    }
}
