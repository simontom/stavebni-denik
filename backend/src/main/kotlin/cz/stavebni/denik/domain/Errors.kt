package cz.stavebni.denik.domain

/** Maps to HTTP 404. */
class NotFoundException(message: String) : RuntimeException(message)

/**
 * The request is valid and allowed, but the record is in a state that does not
 * permit it (for example signing a report that is already signed). Maps to HTTP 409.
 */
class ConflictException(message: String) : RuntimeException(message)
