package cz.stavebni.denik.services

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.lang.management.ManagementFactory
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread
import kotlin.math.ceil
import kotlin.math.sqrt

/**
 * Why a progressive JPEG is limited to [PhotoService.MAX_PROGRESSIVE_JPEG_PIXELS] and not to the 64 megapixels of a baseline
 * one: it MEASURES what the decoder needs.
 *
 * The decoder keeps the coefficients of the whole image of a progressive file in **native** memory (libjpeg's allocator, not
 * the Java heap): 2 bytes per sample, up to 6 bytes per pixel for the worst case, a file with full-resolution chroma (4:4:4).
 * So the test builds the largest such file the airlock accepts with the JDK's own encoder and decodes it, through the real
 * airlock function, in a **separate JVM with a heap of only 64 MiB** (fixed, so that the heap cannot grow and cannot be
 * where the memory goes). The child samples the process's committed memory before and during the decode and reports the
 * growth.
 *
 * Measured on the development machine (Windows, JDK 21): 97.5 MiB for 16 megapixels (6.4 bytes per pixel, of which about
 * 6.0 are the coefficients and the rest is fixed cost), 373.5 MiB for 64 megapixels (the 384 MB of the review's estimate),
 * and 8 s of CPU for that one decode. With two decode slots a 64-megapixel progressive file would take 747 MiB of a 1 GB
 * machine, whose heap alone may take 400 MiB; 16 megapixels take 195 MiB for both slots.
 *
 * The worst file is the largest one with the **most scans** the airlock accepts ([PhotoService.MAX_JPEG_SCANS]): memory does
 * not depend on the scans but time does. Measured: 104 MiB and 4.7 s for this file; the ordinary 10-scan file of the same
 * size takes 2.3 s, so each extra scan costs about 0.11 s. Without a cap, 5 MiB of 12-byte scans would be hours.
 *
 * Only 3 components count as the worst case because a multi-scan file with a fourth is refused (it would be 8 bytes per
 * pixel; the JDK decodes such files).
 */
class ProgressiveJpegMemoryTest {

    /**
     * What a 1 GB machine can spare for the native memory of image decoding. The heap is capped at 40 % (400 MB); Argon2
     * may hold up to 4 x 64 MiB, the JVM itself and the typst processes need the rest (`PROJECT.md`, "Memory").
     * Raising [PhotoService.MAX_PROGRESSIVE_JPEG_PIXELS] makes this test fail unless the machine got bigger.
     */
    private val nativeBudgetMiB = 256

    @Test
    fun `the largest progressive JPEG the airlock accepts fits in the memory the machine can spare, outside the heap`() {
        // The worst case: full-resolution chroma (4:4:4) at exactly the number of pixels the airlock allows.
        val limit = PhotoService.MAX_PROGRESSIVE_JPEG_PIXELS
        val width = ceil(sqrt(limit.toDouble())).toInt()
        val height = (limit / width).toInt()
        val pixels = width.toLong() * height
        assertTrue(pixels <= limit && pixels >= limit * 0.999, "the test picture must have (all but exactly) the permitted number of pixels, has $pixels of $limit")
        // ... with the most scans the airlock accepts: the memory does not depend on them, the time does.
        val jpeg = JpegSamples.withScansUpTo(
            JpegSamples.smooth(width, height, progressive = true, fullChroma = true),
            PhotoService.MAX_JPEG_SCANS
        )
        assertTrue(jpeg.size < PhotoService.MAX_UPLOAD_BYTES, "a file that is under the upload limit, was ${jpeg.size}")
        assertEquals(PhotoService.MAX_JPEG_SCANS, JpegHeader.frameOf(jpeg)!!.scans)
        val file = Files.createTempFile("progressive-", ".jpg")
        try {
            Files.write(file, jpeg)

            val result = decodeInSmallJvm(file.toFile())

            println(
                "MEASURED: ${result.growthMiB} MiB of native memory for $width x $height progressive 4:4:4 with ${PhotoService.MAX_JPEG_SCANS} scans " +
                    "(${result.growthMiB * 1048576 / pixels} bytes per pixel), decoded in ${result.millis} ms"
            )
            assertEquals(width to height, result.size, "the picture was decoded")
            assertTrue(result.growthMiB > 40, "the measurement must see the coefficients (about 90 MiB expected), saw ${result.growthMiB} MiB: the probe is blind")
            assertTrue(
                result.growthMiB * PhotoService.IMAGE_SLOTS <= nativeBudgetMiB,
                "${PhotoService.IMAGE_SLOTS} decode slots x ${result.growthMiB} MiB = ${PhotoService.IMAGE_SLOTS * result.growthMiB} MiB of native memory, " +
                    "more than the $nativeBudgetMiB MiB a 1 GB machine can spare: lower the limit or raise the machine"
            )
        } finally {
            Files.deleteIfExists(file)
        }
    }

    private class Probe(val growthMiB: Long, val size: Pair<Int, Int>, val millis: Long)

    private fun decodeInSmallJvm(file: File): Probe {
        val java = File(System.getProperty("java.home"), "bin/java" + if (System.getProperty("os.name").lowercase().contains("windows")) ".exe" else "")
        val command = listOf(
            java.path, "-Xms64m", "-Xmx64m", "-XX:+ExitOnOutOfMemoryError",
            "-cp", System.getProperty("java.class.path"),
            ProgressiveDecodeProbe::class.java.name, file.path
        )
        val process = ProcessBuilder(command)
            .redirectErrorStream(true)
            // glibc gives every thread its own 64 MiB arena of address space, which a measurement of committed memory counts.
            .also { it.environment()["MALLOC_ARENA_MAX"] = "1" }
            .start()
        val output = StringBuilder()
        val reader = thread { process.inputStream.bufferedReader().forEachLine { output.appendLine(it) } }
        if (!process.waitFor(180, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            fail<Unit>("the decoding JVM did not finish in time:\n$output")
        }
        reader.join(5_000)
        assertEquals(0, process.exitValue(), "decoding under a 64 MiB heap must work: it is native memory, not heap. Output:\n$output")
        val line = output.lines().firstOrNull { it.startsWith("PROBE ") } ?: fail("no result from the decoding JVM:\n$output")
        val parts = line.removePrefix("PROBE ").split(' ')
        val (w, h) = parts[1].split('x').map { it.toInt() }
        return Probe(parts[0].toLong(), w to h, parts[2].toLong())
    }
}

/**
 * Runs in the child JVM of [ProgressiveJpegMemoryTest]: decodes one file through the airlock and prints how much the
 * process's committed memory grew. A thread samples it every 2 ms (it is started, and takes its baseline, before the decode).
 */
object ProgressiveDecodeProbe {
    @JvmStatic
    fun main(args: Array<String>) {
        val os = ManagementFactory.getOperatingSystemMXBean() as com.sun.management.OperatingSystemMXBean
        val baseline = AtomicLong()
        val peak = AtomicLong()
        val ready = CountDownLatch(1)
        val stop = AtomicBoolean(false)
        val sampler = thread(isDaemon = true) {
            baseline.set(os.committedVirtualMemorySize)
            peak.set(baseline.get())
            ready.countDown()
            while (!stop.get()) {
                peak.accumulateAndGet(os.committedVirtualMemorySize, ::maxOf)
                Thread.sleep(2)
            }
        }
        ready.await()

        val bytes = File(args[0]).readBytes()
        val started = System.nanoTime()
        val image = PhotoService.decodeWithinLimits(bytes)
        val millis = (System.nanoTime() - started) / 1_000_000
        // The size of the original is what the header says; the image returned is the reduced one.
        val frame = requireNotNull(JpegHeader.frameOf(bytes))

        stop.set(true)
        sampler.join()
        val growthMiB = (peak.get() - baseline.get()) / 1_048_576
        println("PROBE $growthMiB ${frame.width}x${frame.height} $millis (decoded to ${image.width}x${image.height})")
    }
}
