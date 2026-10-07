package cz.stavebni.denik.domain

import kotlinx.serialization.Serializable

@Serializable
enum class Role {
    BOSS,
    WORKER,
    INSPECTOR,
    INVESTOR
}
