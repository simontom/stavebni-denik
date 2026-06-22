# Container used by test/integration/backup.int.test.ts to actually
# exercise scripts/backup.sh (pg_dump + restic) end-to-end. Kept as a
# small bespoke image so the test isn't coupled to whatever the
# production runner image happens to bundle.
#
# Alpine because both `postgresql-client` and `restic` are first-class
# packages there; bash is needed because backup.sh relies on bash
# extensions (`[[ ]]`, arrays).
#
# 3.22 ships postgresql17-client, matching the prod target. Bump in
# lock-step with the production Postgres major when we move on.
FROM alpine:3.22

RUN apk add --no-cache \
      bash \
      postgresql17-client \
      restic \
      ca-certificates \
      tzdata

# Keep the container alive — the test runs commands via exec().
ENTRYPOINT ["sleep", "infinity"]
