package cz.stavebni.denik

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

/**
 * JUnit 5 silently SKIPS a test method that returns a value: a Kotlin test written as
 * `fun x() = runBlocking { ...; assertThrows<E> { } }` returns whatever its last expression is, and is neither run nor
 * reported. The same goes for `suspend` test methods. This test finds every such method in the compiled test classes, so
 * a "passing" suite can no longer hide tests that never ran. Fix an offender with `= runBlocking<Unit> { }` or a block body.
 */
class NoSilentlySkippedTestsTest {

    private val testAnnotations = setOf(
        "org.junit.jupiter.api.Test",
        "org.junit.jupiter.api.RepeatedTest",
        "org.junit.jupiter.params.ParameterizedTest",
    )

    @Test
    fun `no test method returns a value or is suspend`() {
        val root = File(NoSilentlySkippedTestsTest::class.java.protectionDomain.codeSource.location.toURI())
        val classes = root.walkTopDown().filter { it.isFile && it.extension == "class" }.toList()
        assertTrue(classes.size > 20, "expected to find the compiled test classes under $root, found ${classes.size}")

        val loader = NoSilentlySkippedTestsTest::class.java.classLoader
        var testMethods = 0
        val offenders = mutableListOf<String>()
        for (file in classes) {
            val name = root.toPath().relativize(file.toPath()).toString().removeSuffix(".class").replace(File.separatorChar, '.')
            val type = runCatching { Class.forName(name, false, loader) }.getOrNull() ?: continue
            for (method in type.declaredMethods) {
                if (method.annotations.none { it.annotationClass.qualifiedName in testAnnotations }) continue
                testMethods++
                val suspending = method.parameterTypes.any { it.name == "kotlin.coroutines.Continuation" }
                if (method.returnType != Void.TYPE || suspending) {
                    offenders += "${type.simpleName}.${method.name} returns ${method.returnType.simpleName}${if (suspending) " and is suspend" else ""}"
                }
            }
        }

        assertTrue(testMethods > 100, "expected to find the test methods, found $testMethods")
        assertTrue(
            offenders.isEmpty(),
            "These tests are silently skipped by JUnit (use runBlocking<Unit> or a block body):\n" + offenders.sorted().joinToString("\n")
        )
    }
}
