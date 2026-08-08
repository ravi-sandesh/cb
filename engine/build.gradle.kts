// ============================================================
// ChokaBarah – "engine" pure-JVM module
// ------------------------------------------------------------
// Holds the rules engine (GameModels, GameEngine, TrackBuilder)
// and the telemetry logger. Deliberately Android-free so the core
// logic + its unit tests run on a bare JDK with `./gradlew :engine:test`
// (no Android SDK required). The Android `:app` module depends on it.
// ============================================================
plugins {
    alias(libs.plugins.kotlin.jvm)
}

java {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    kotlinOptions.jvmTarget = "1.8"
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:1.9.24")
}

tasks.test {
    useJUnit()
}