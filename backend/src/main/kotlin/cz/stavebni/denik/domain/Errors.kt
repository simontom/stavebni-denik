package cz.stavebni.denik.domain

/** Maps to HTTP 404. */
class NotFoundException(message: String) : RuntimeException(message)

/**
 * The request is valid and allowed, but the record is in a state that does not
 * permit it (for example signing a report that is already signed). Maps to HTTP 409.
 */
class ConflictException(message: String) : RuntimeException(message)

/**
 * The entry was changed (or is gone) since the client read it: the save was based on an outdated version.
 * Maps to HTTP 409 with `code: STALE_VERSION`, so the client can offer to reload instead of showing a plain error.
 */
class StaleVersionException(message: String) : RuntimeException(message)

/** Too many attempts in a short time. Maps to HTTP 429 with a `Retry-After` header. */
class TooManyRequestsException(val retryAfterSeconds: Long, message: String) : RuntimeException(message)

/**
 * The person has the right role but lacks something the law requires of a signer (a ČKAIT number). Maps to HTTP 403 and,
 * unlike a plain [ForbiddenException], tells the person why: they can fix it (an administrator fills the number in).
 */
class SignerNotQualifiedException(message: String) : RuntimeException(message)
