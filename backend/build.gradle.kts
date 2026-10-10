plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
    application
    id("com.gradleup.shadow") version "8.3.0"
}

application {
    mainClass.set("cz.stavebni.denik.ApplicationKt")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

repositories { mavenCentral() }

val ktorVersion = "3.6.0"
// PostgreSQL 18 is the only supported database version.
//   - jOOQ 3.21: OSS SQLDialect.POSTGRES tracks PG18 catalog changes
//   - Flyway >= 11.14: first line that officially supports PG18
//   - pgjdbc >= 42.7.7: fixes CVE-2025-49146
val jooqVersion = "3.21.8"
val flywayVersion = "12.11.0"
val pgJdbcVersion = "42.7.13"
val testcontainersVersion = "1.21.4"
val postgresImage = "postgres:18-alpine"

// Generated jOOQ sources are committed (see generateJooq below) so that
// build/test/Docker builds never need a live database.
val jooqGeneratedDir = layout.projectDirectory.dir("src/generated/jooq")

kotlin {
    sourceSets["main"].kotlin.srcDir(jooqGeneratedDir)
}

val codegen: SourceSet by sourceSets.creating

dependencies {
    implementation("io.ktor:ktor-server-core:$ktorVersion")
    implementation("io.ktor:ktor-server-netty:$ktorVersion")
    implementation("io.ktor:ktor-server-content-negotiation:$ktorVersion")
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
    implementation("io.ktor:ktor-server-cors:$ktorVersion")
    implementation("io.ktor:ktor-server-auth:$ktorVersion")
    implementation("io.ktor:ktor-server-auth-jwt:$ktorVersion")
    implementation("io.ktor:ktor-server-status-pages:$ktorVersion")
    implementation("io.ktor:ktor-server-body-limit:$ktorVersion")
    implementation("io.ktor:ktor-server-rate-limit:$ktorVersion")
    implementation("io.ktor:ktor-server-sessions:$ktorVersion")
    implementation("io.ktor:ktor-server-call-logging:$ktorVersion")

    implementation("io.ktor:ktor-client-core:$ktorVersion")
    implementation("io.ktor:ktor-client-cio:$ktorVersion")
    implementation("io.ktor:ktor-client-content-negotiation:$ktorVersion")

    implementation("org.jooq:jooq:$jooqVersion")
    implementation("org.jooq:jooq-kotlin:$jooqVersion")
    implementation("org.jooq:jooq-kotlin-coroutines:$jooqVersion")

    implementation("org.postgresql:postgresql:$pgJdbcVersion")
    implementation("com.zaxxer:HikariCP:6.2.1")

    implementation("org.flywaydb:flyway-core:$flywayVersion")
    implementation("org.flywaydb:flyway-database-postgresql:$flywayVersion")

    implementation("com.auth0:java-jwt:4.4.0")
    implementation("de.mkammerer:argon2-jvm:2.11")

    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("io.konform:konform:0.7.0")
    implementation("net.coobird:thumbnailator:0.4.20")

    implementation("ch.qos.logback:logback-classic:1.5.12")

    testImplementation("io.ktor:ktor-server-test-host:$ktorVersion")
    testImplementation("io.ktor:ktor-client-mock:$ktorVersion")
    testImplementation("org.jetbrains.kotlin:kotlin-test")
    testImplementation("org.testcontainers:testcontainers:$testcontainersVersion")
    testImplementation("org.testcontainers:postgresql:$testcontainersVersion")
    testImplementation("org.testcontainers:junit-jupiter:$testcontainersVersion")
    testImplementation("org.wiremock:wiremock:3.10.0")
    // Reads the text of a generated PDF back, to check what the real typst rendered.
    testImplementation("org.apache.pdfbox:pdfbox:3.0.4")

    // jOOQ code generation toolchain (runs only via `generateJooq`)
    "codegenImplementation"("org.jooq:jooq-codegen:$jooqVersion")
    "codegenImplementation"("org.jooq:jooq-meta:$jooqVersion")
    "codegenImplementation"("org.flywaydb:flyway-core:$flywayVersion")
    "codegenImplementation"("org.flywaydb:flyway-database-postgresql:$flywayVersion")
    "codegenImplementation"("org.postgresql:postgresql:$pgJdbcVersion")
    "codegenImplementation"("org.testcontainers:postgresql:$testcontainersVersion")
    "codegenRuntimeOnly"("org.slf4j:slf4j-simple:2.0.17")
}

val isWindows = System.getProperty("os.name").lowercase().contains("windows")

fun JavaForkOptions.configureDockerForWindows() {
    if (isWindows) {
        systemProperty("api.version", "1.44")
        systemProperty("docker.api.version", "1.44")
        environment("DOCKER_API_VERSION", "1.44")
        if (System.getenv("DOCKER_HOST") == null) {
            environment("DOCKER_HOST", "npipe:////./pipe/dockerDesktopLinuxEngine")
        }
    }
}

/**
 * Regenerates the jOOQ classes in src/generated/jooq:
 * starts a throwaway PostgreSQL 18 container (Testcontainers), applies the
 * Flyway migrations and introspects the resulting schema.
 *
 * Run after every migration change and commit the result:
 *   ./gradlew :backend:generateJooq
 * CI fails the PR when the committed sources drift from the migrations.
 */
tasks.register<JavaExec>("generateJooq") {
    group = "jooq"
    description = "Generate jOOQ sources from Flyway migrations against PostgreSQL 18 (Testcontainers)"
    classpath = codegen.runtimeClasspath
    mainClass.set("cz.stavebni.denik.codegen.JooqCodegen")
    args(
        layout.projectDirectory.dir("src/main/resources/db/migration").asFile.absolutePath,
        jooqGeneratedDir.asFile.absolutePath,
        postgresImage,
    )
    inputs.dir("src/main/resources/db/migration")
    outputs.dir(jooqGeneratedDir)
    configureDockerForWindows()
}

// Flyway (and Ktor) discover their modules through META-INF/services files that
// exist in several jars. Without merging them the fat jar keeps only one copy
// (for Flyway just the 3 PostgreSQL entries instead of ~40) and Flyway.configure()
// fails with a NullPointerException at startup.
tasks.shadowJar {
    mergeServiceFiles()
}

tasks.test {
    useJUnitPlatform()
    configureDockerForWindows()
    testLogging {
        events("passed", "skipped", "failed")
        showStandardStreams = true
    }
}
