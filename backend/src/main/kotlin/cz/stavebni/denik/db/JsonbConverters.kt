package cz.stavebni.denik.db

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.jooq.Converter
import org.jooq.JSONB

val defaultJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
}

inline fun <reified T> jsonbConverter(): Converter<JSONB, T> =
    Converter.of(
        JSONB::class.java, T::class.java,
        { jsonb -> defaultJson.decodeFromString<T>(jsonb.data()) },
        { obj -> JSONB.jsonb(defaultJson.encodeToString(obj)) }
    )
