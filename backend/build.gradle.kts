buildscript {
    repositories { mavenCentral() }
    dependencies {
        classpath("org.postgresql:postgresql:42.7.4")
        classpath("org.flywaydb:flyway-database-postgresql:10.22.0")
    }
}

plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
    application
    id("org.flywaydb.flyway") version "10.22.0"
    id("nu.studer.jooq") version "9.0"
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

val ktorVersion = "3.1.1"
val jooqVersion = "3.19.16"
val flywayVersion = "10.22.0"
val testcontainersVersion = "1.20.4"

dependencies {
    implementation("io.ktor:ktor-server-core:$ktorVersion")
    implementation("io.ktor:ktor-server-netty:$ktorVersion")
    implementation("io.ktor:ktor-server-content-negotiation:$ktorVersion")
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
    implementation("io.ktor:ktor-server-cors:$ktorVersion")
    implementation("io.ktor:ktor-server-auth:$ktorVersion")
    implementation("io.ktor:ktor-server-auth-jwt:$ktorVersion")
    implementation("io.ktor:ktor-server-status-pages:$ktorVersion")
    implementation("io.ktor:ktor-server-rate-limit:$ktorVersion")
    implementation("io.ktor:ktor-server-sessions:$ktorVersion")
    implementation("io.ktor:ktor-server-call-logging:$ktorVersion")
    
    implementation("io.ktor:ktor-client-core:$ktorVersion")
    implementation("io.ktor:ktor-client-cio:$ktorVersion")
    implementation("io.ktor:ktor-client-content-negotiation:$ktorVersion")

    implementation("org.jooq:jooq:$jooqVersion")
    implementation("org.jooq:jooq-kotlin:$jooqVersion")
    implementation("org.jooq:jooq-kotlin-coroutines:$jooqVersion")

    implementation("org.postgresql:postgresql:42.7.4")
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
    
    jooqGenerator("org.postgresql:postgresql:42.7.4")
}

flyway {
    url = "jdbc:postgresql://localhost:5432/stavebni_denik"
    user = "denik"
    password = "denik_dev"
    locations = arrayOf("filesystem:src/main/resources/db/migration")
}

jooq {
    version.set(jooqVersion)
    edition.set(nu.studer.gradle.jooq.JooqEdition.OSS)
    configurations {
        create("main") {
            jooqConfiguration.apply {
                jdbc.apply {
                    driver = "org.postgresql.Driver"
                    url = "jdbc:postgresql://localhost:5432/stavebni_denik"
                    user = "denik"
                    password = "denik_dev"
                }
                generator.apply {
                    name = "org.jooq.codegen.KotlinGenerator"
                    database.apply {
                        name = "org.jooq.meta.postgres.PostgresDatabase"
                        inputSchema = "public"
                    }
                    generate.apply {
                        isKotlinSetterJvmNameAnnotationsOnIsPrefix = true
                        isPojosAsKotlinDataClasses = true
                    }
                    target.apply {
                        packageName = "cz.stavebni.denik.jooq"
                        directory = "build/generated-sources/jooq"
                    }
                }
            }
        }
    }
}

// Ensure flyway runs before jooq
tasks.named("generateJooq") {
    dependsOn("flywayMigrate")
}

tasks.test {
    useJUnitPlatform()
    val isWindows = System.getProperty("os.name").lowercase().contains("windows")
    if (isWindows) {
        systemProperty("api.version", "1.44")
        systemProperty("docker.api.version", "1.44")
        environment("DOCKER_API_VERSION", "1.44")
        if (System.getenv("DOCKER_HOST") == null) {
            environment("DOCKER_HOST", "npipe:////./pipe/dockerDesktopLinuxEngine")
        }
    }
    testLogging {
        events("passed", "skipped", "failed")
        showStandardStreams = true
    }
}





