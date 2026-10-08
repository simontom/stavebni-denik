-- ---------------------------------------------------------------------------
-- Nicknames are unique regardless of case.
--
-- V1 made "nickname" unique, but only exactly: "alice" and "Alice" could both
-- exist, which in a legal record means look-alike accounts (and they share one
-- login lockout, which is keyed by the lower-cased name). Login stays
-- case-sensitive; creating a name that differs only in case is refused.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "users_nickname_lower_key" ON "users" (lower("nickname"));
