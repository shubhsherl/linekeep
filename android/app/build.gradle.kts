import java.net.URI
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp") version "2.1.20-1.0.32"
}

val localSettings = Properties().apply {
    val settingsFile = rootProject.file("linekeep.local.properties")
    if (settingsFile.isFile) settingsFile.inputStream().use { load(it) }
}
val apiBaseUrl = providers.gradleProperty("linekeep.apiBaseUrl")
    .orElse(providers.environmentVariable("LINEKEEP_API_BASE_URL"))
    .orElse(provider { localSettings.getProperty("apiBaseUrl", "") })
    .get().trim().trimEnd('/')
require(apiBaseUrl.isNotEmpty()) {
    "Set -Plinekeep.apiBaseUrl=https://your-worker.example, LINEKEEP_API_BASE_URL, or apiBaseUrl in android/linekeep.local.properties."
}
val apiOrigin = URI(apiBaseUrl)
require(apiOrigin.scheme == "https" && !apiOrigin.host.isNullOrBlank() &&
    apiOrigin.rawUserInfo == null && apiOrigin.rawQuery == null && apiOrigin.rawFragment == null &&
    apiOrigin.rawPath.isNullOrEmpty()) {
    "The Linekeep API base URL must be an HTTPS origin without credentials, path, query or fragment."
}

android {
    namespace = "com.microorganics.calltracker"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.microorganics.calltracker"
        minSdk = 26
        targetSdk = 35
        versionCode = 5
        versionName = "0.4.1"
        buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.04.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.room:room-runtime:2.7.1")
    implementation("androidx.room:room-ktx:2.7.1")
    ksp("androidx.room:room-compiler:2.7.1")
    testImplementation("junit:junit:4.13.2")
}
