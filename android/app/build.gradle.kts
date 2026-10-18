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
// Optional: a build may pre-seed a default server (for example a dev APK). The generic APK has none and
// receives its server at runtime from a setup QR code or the Advanced screen.
val apiBaseUrl = providers.gradleProperty("linekeep.apiBaseUrl")
    .orElse(providers.environmentVariable("LINEKEEP_API_BASE_URL"))
    .orElse(provider { localSettings.getProperty("apiBaseUrl", "") })
    .get().trim().trimEnd('/')
val appLabelSuffix = providers.gradleProperty("linekeep.appLabelSuffix")
    .orElse(providers.environmentVariable("LINEKEEP_APP_LABEL_SUFFIX"))
    .orElse(provider { localSettings.getProperty("appLabelSuffix", "") })
    .get().trim()
val appLabel = if (appLabelSuffix.isEmpty()) "Linekeep" else "Linekeep ($appLabelSuffix)"
if (apiBaseUrl.isNotEmpty()) {
    val apiOrigin = URI(apiBaseUrl)
    require(apiOrigin.scheme == "https" && !apiOrigin.host.isNullOrBlank() &&
        apiOrigin.rawUserInfo == null && apiOrigin.rawQuery == null && apiOrigin.rawFragment == null &&
        apiOrigin.rawPath.isNullOrEmpty()) {
        "The Linekeep API base URL must be an HTTPS origin without credentials, path, query or fragment."
    }
}

// Release signing material lives outside Git. Without the file, `assembleRelease` yields an unsigned APK.
// Point elsewhere with -Plinekeep.signingProperties=/path/to/signing.properties.
val signingFile = providers.gradleProperty("linekeep.signingProperties")
    .map { file(it) }
    .orElse(provider { rootProject.file("../.private/release/signing.properties") }).get()
val signing = Properties().apply { if (signingFile.isFile) signingFile.inputStream().use { load(it) } }

android {
    namespace = "com.microorganics.calltracker"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.microorganics.calltracker"
        minSdk = 26
        targetSdk = 35
        versionCode = 11
        versionName = "1.0.1"
        buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
        resValue("string", "app_name", appLabel)
    }
    signingConfigs {
        if (signing.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        release {
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
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
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    ksp("androidx.room:room-compiler:2.7.1")
    testImplementation("junit:junit:4.13.2")
    // The Android stub jar throws for org.json in JVM tests; the parsers under test are pure.
    testImplementation("org.json:json:20240303")
}
