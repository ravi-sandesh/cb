plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Enable structured telemetry via: ./gradlew assembleDebug -PtelemetryEnabled=true
val telemetryEnabled: String = (project.findProperty("telemetryEnabled") as? String)?.toBoolean()?.toString() ?: "false"

android {
    namespace = "com.chokabarah.game"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.chokabarah.game"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }

        // Compile-time telemetry flag (runtime can also override via system property).
        buildConfigField("boolean", "ENABLE_TELEMETRY", telemetryEnabled)
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // Rules engine lives in the pure-JVM :engine module.
    implementation(project(":engine"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)

    // Unit testing
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:1.9.24")
    testImplementation("org.jetbrains.kotlin:kotlin-test:1.9.24")

    // AndroidX Test - Unit tests with Android framework
    testImplementation("androidx.test:core:1.5.0")
    testImplementation("androidx.test:rules:1.5.0")
    testImplementation("androidx.test.ext:junit:1.1.5")
    testImplementation("org.mockito:mockito-core:5.9.0")
    testImplementation("org.mockito.kotlin:mockito-kotlin:5.1.0")

    // Compose UI Testing
    testImplementation("androidx.compose.ui:ui-test-junit4:1.6.0")
    testImplementation("androidx.compose.ui:ui-test-manifest:1.6.0")

    // Instrumented tests
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
    androidTestImplementation("androidx.test:rules:1.5.0")
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4:1.6.0")
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation("androidx.activity:activity-compose:1.9.0")

    // Debug/Preview
    debugImplementation("androidx.compose.ui:ui-tooling:1.6.0")
    debugImplementation("androidx.compose.ui:ui-tooling-preview:1.6.0")
    // Compose testing activity (merged into the debug app manifest at the app package/process).
    debugImplementation("androidx.compose.ui:ui-test-manifest:1.6.0")
}