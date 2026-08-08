pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ChokaBarah"

// The engine is a pure-JVM module and always included.
include(":engine")

// The Android app module requires the Android SDK at configuration time.
// It is included by default, but can be skipped (CB_ENGINE_ONLY=1) so the
// SDK-free engine test job can run `:engine:test` without any Android tooling.
if (System.getenv("CB_ENGINE_ONLY") != "1") {
    include(":app")
}
