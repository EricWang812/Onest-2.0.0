plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.focuslock.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.focuslock.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.15"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.11.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")

    // Local persistence: sessions, settings, devices, active_session — see
    // android/app/src/main/kotlin/com/focuslock/app/data/.
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // Encrypted DataStore for the session/ends_at dead-man's-switch state,
    // read on every service start per spec.
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Relay WebSocket client.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Ed25519 signing + AES-GCM for the group-key transport, pure-JVM so it
    // works uniformly across minSdk 26+ regardless of OS crypto-provider
    // version (Android's built-in Ed25519 support varies by API level). See
    // DECISIONS.md for why SPAKE2 itself is NOT implemented via this or any
    // other library in this build.
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    // QR code rendering for the pairing screen.
    implementation("com.google.zxing:core:3.5.3")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
