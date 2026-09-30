package cz.stavebni.denik.codegen;

import org.flywaydb.core.Flyway;
import org.jooq.codegen.GenerationTool;
import org.jooq.meta.jaxb.Configuration;
import org.jooq.meta.jaxb.Database;
import org.jooq.meta.jaxb.Generate;
import org.jooq.meta.jaxb.Generator;
import org.jooq.meta.jaxb.Jdbc;
import org.jooq.meta.jaxb.Target;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Generates jOOQ sources from the Flyway migrations.
 *
 * <p>Starts a throwaway PostgreSQL container, runs Flyway against it and lets
 * jOOQ introspect the real PG18 schema. Output is deterministic so CI can
 * detect drift with {@code git diff --exit-code}.
 *
 * <p>Args: {@code <migrationsDir> <targetDir> <postgresImage>}
 */
public final class JooqCodegen {

    private JooqCodegen() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 3) {
            throw new IllegalArgumentException("usage: JooqCodegen <migrationsDir> <targetDir> <postgresImage>");
        }
        String migrationsDir = args[0];
        String targetDir = args[1];
        String image = args[2];

        try (PostgreSQLContainer<?> pg = new PostgreSQLContainer<>(DockerImageName.parse(image).asCompatibleSubstituteFor("postgres"))) {
            pg.start();

            Flyway.configure()
                .dataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword())
                .locations("filesystem:" + migrationsDir)
                .load()
                .migrate();

            Configuration configuration = new Configuration()
                .withJdbc(new Jdbc()
                    .withDriver("org.postgresql.Driver")
                    .withUrl(pg.getJdbcUrl())
                    .withUser(pg.getUsername())
                    .withPassword(pg.getPassword()))
                .withGenerator(new Generator()
                    .withName("org.jooq.codegen.KotlinGenerator")
                    .withDatabase(new Database()
                        .withName("org.jooq.meta.postgres.PostgresDatabase")
                        .withInputSchema("public")
                        .withExcludes("flyway_schema_history"))
                    .withGenerate(new Generate()
                        .withKotlinSetterJvmNameAnnotationsOnIsPrefix(true)
                        .withPojosAsKotlinDataClasses(true))
                    .withTarget(new Target()
                        .withPackageName("cz.stavebni.denik.jooq")
                        .withDirectory(targetDir)
                        .withClean(true)));

            GenerationTool.generate(configuration);
        }
    }
}
