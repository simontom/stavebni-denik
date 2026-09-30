package cz.stavebni.denik.domain

/** Maps to HTTP 404. */
class NotFoundException(message: String) : RuntimeException(message)
