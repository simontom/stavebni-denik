package cz.stavebni.denik.services

import cz.stavebni.denik.util.Text
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/** The budget of printed lines (see [PrintBudget]): how lines are counted, where a text is cut, and the sentence that says so. */
class PrintBudgetTest {

    private fun lines(count: Int, separator: String = "\n", line: (Int) -> String = { "řádek $it" }) = (1..count).joinToString(separator, transform = line)

    @Test
    fun `a line is as many printed lines as its characters fill, an empty one is one, and a break is whatever ends a line in the document`() {
        assertEquals(1, PrintBudget.linesOf("", 40))
        assertEquals(1, PrintBudget.linesOf("a".repeat(40), 40))
        assertEquals(2, PrintBudget.linesOf("a".repeat(41), 40))
        assertEquals(3, PrintBudget.linesOf("a\nb\nc", 40))
        assertEquals(3, PrintBudget.linesOf("a\r\nb\rc", 40), "CRLF is one break, CR is one")
        assertEquals(1001, PrintBudget.linesOf("\n".repeat(1000), 40), "a text of nothing but breaks is a thousand lines")
        assertEquals(3, PrintBudget.linesOf("a b c", 40), "the separators of Unicode end a line as well")
        assertEquals(1, PrintBudget.linesOf("🚧".repeat(40), 40), "characters as a person counts them")
        // The same count as the limit of the lines that people may enter.
        for (text in listOf("", "a", "a\nb", "a\r\n\r\nb", "a\u000Bb\u000Cc\u0085d e f")) {
            assertEquals(Text.lineCount(text), PrintBudget.linesOf(text, 1_000_000), text.replace(Regex("[\\p{Cntrl}  ]"), "?"))
        }
    }

    @Test
    fun `a text that fits is taken whole and its lines are spent`() {
        val budget = PrintBudget(100)

        val taken = budget.take(lines(30), charsPerLine = 40)

        assertEquals(lines(30), taken.text)
        assertEquals(0, taken.omitted)
        assertEquals(70, budget.left)
    }

    @Test
    fun `a text that does not fit is cut at the end of a line, and the lines that were left out are counted`() {
        val budget = PrintBudget(100)

        val taken = budget.take(lines(500), charsPerLine = 40, cap = 20)

        assertEquals(lines(20), taken.text, "the cap of the field")
        assertEquals(480, taken.omitted)
        assertEquals(80, budget.left, "only what was printed is spent")
        val rest = budget.take(lines(500), charsPerLine = 40)
        assertEquals(lines(80), rest.text, "what is left of the budget")
        assertEquals(420, rest.omitted)
        assertEquals(0, budget.left)
        val nothing = budget.take("x\ny", charsPerLine = 40)
        assertEquals("", nothing.text)
        assertEquals(2, nothing.omitted)
    }

    @Test
    fun `a text of nothing but newlines is cut to the budget however many there are`() {
        val budget = PrintBudget(300)

        val taken = budget.take("\n".repeat(200_000) + "x", charsPerLine = 40)

        assertEquals(300, PrintBudget.linesOf(taken.text, 40), "no more lines than the budget")
        assertEquals(200_001 - 300, taken.omitted)
        assertTrue(taken.text.length <= 300)
    }

    @Test
    fun `a single long line is cut inside the line when not even one line of it fits, and the line break that ended it is kept as it was`() {
        val budget = PrintBudget(3)

        val taken = budget.take("a".repeat(1000), charsPerLine = 10)

        assertEquals(30, taken.text.length, "three printed lines of ten characters")
        assertEquals(97, taken.omitted)
        // The text is cut where the original was, with the breaks it had.
        val crlf = PrintBudget(2).take("first\r\nsecond\r\nthird", charsPerLine = 40)
        assertEquals("first\r\nsecond", crlf.text)
        assertEquals(1, crlf.omitted)
    }

    @Test
    fun `a cut never splits a character that is more than one code unit`() {
        val taken = PrintBudget(2).take("🚧".repeat(100), charsPerLine = 10)

        assertEquals(20, taken.text.codePointCount(0, taken.text.length))
        assertTrue(taken.text.all { !it.isSurrogate() } || taken.text.length == 40, "whole characters")
        assertEquals("🚧".repeat(20), taken.text)
    }

    @Test
    fun `a row of a table is as tall as its tallest cell, and a row that does not fit spends nothing`() {
        val budget = PrintBudget(10)

        val first = budget.row(listOf("a", lines(4), "c"), charsPerLine = 20, cap = 6)!!

        assertEquals(4, first.cost)
        assertEquals(6, budget.left)
        // A cell is cut to the cap, and what was left out of it is counted.
        val tall = budget.row(listOf(lines(50), "b", "c"), charsPerLine = 20, cap = 6)!!
        assertEquals(6, tall.cost)
        assertEquals(44, tall.omitted)
        assertEquals(0, budget.left)
        assertNull(budget.row(listOf("a", "b", "c"), charsPerLine = 20, cap = 6), "nothing is left")
        assertEquals(0, budget.left)
    }

    @Test
    fun `nothing costs nothing and is never cut, and a text of which nothing fits is shown as an ellipsis, not as an empty place`() {
        val budget = PrintBudget(1)

        val nothing = budget.take("", charsPerLine = 40)
        assertEquals(0, nothing.omitted)
        assertEquals("", nothing.shown, "an empty place stays empty: the document says bez záznamu there")
        assertEquals(1, budget.left)

        assertEquals("x", budget.take("x", charsPerLine = 40).shown)
        val exhausted = budget.take("something", charsPerLine = 40)
        assertEquals("", exhausted.text)
        assertEquals(1, exhausted.omitted)
        assertEquals("…", exhausted.shown, "there was a text, so the place is not empty")
        assertEquals("", budget.take("", charsPerLine = 40).shown, "still nothing, with the budget used up")
    }

    @Test
    fun `a fixed cost is spent whole or not at all`() {
        val budget = PrintBudget(10)

        assertTrue(budget.spend(6))
        assertFalse(budget.spend(6))
        assertEquals(4, budget.left)
    }

    @Test
    fun `the sentence about what was left out is in the Czech form that goes with the number, and empty for nothing`() {
        assertEquals("", PrintBudget.omittedLines(0))
        assertEquals("… a další 1 řádek se do tohoto výtisku nevešel; úplné znění je v aplikaci.", PrintBudget.omittedLines(1))
        assertEquals("… a další 3 řádky se do tohoto výtisku nevešly; úplné znění je v aplikaci.", PrintBudget.omittedLines(3))
        assertEquals("… a dalších 12 řádků se do tohoto výtisku nevešlo; úplné znění je v aplikaci.", PrintBudget.omittedLines(12))
        assertEquals("… a další 2 protokoly se do tohoto výtisku nevešly; úplné znění je v aplikaci.", PrintBudget.omittedProtocols(2))
        assertEquals("… a dalších 7 protokolů se do tohoto výtisku nevešlo; úplné znění je v aplikaci.", PrintBudget.omittedProtocols(7))
        assertEquals("… a dalších 5 záznamů se do tohoto výtisku nevešlo; úplné znění je v aplikaci.", PrintBudget.omittedRecords(5))
    }
}
