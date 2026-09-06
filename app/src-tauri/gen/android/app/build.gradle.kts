import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// The app version, from the one place it lives: src-tauri/Cargo.toml. Read
// here rather than trusted to tauri.properties above, which is gitignored,
// generated, and -- measured on this project -- simply not written by
// `tauri android build`, because tauri.conf.json deliberately omits its own
// `version` field so Tauri reads the crate's (see CLAUDE.md). The scaffold's
// fallbacks are versionName "1.0" and versionCode 1, so without this every
// release ships as the same version and Android refuses to install one over
// another: an update needs a versionCode strictly greater than the installed
// one, and 1 is never greater than 1. That is a bug you find on the second
// release, from a user who cannot take it.
//
// Parsed with a regex over the first `version = "x.y.z"` line rather than a
// TOML library, which matches how .github/workflows/app-release.yml checks the
// tag against the same file. The dependency versions below it are all inside
// inline tables and do not start a line.
val crateVersion: String = rootProject.file("../../Cargo.toml").readLines()
    .firstNotNullOfOrNull { Regex("""^version = "(.*)"$""").find(it)?.groupValues?.get(1) }
    ?: "0.0.0"

// Monotonic in the semver, with room for 999 of each component. Android wants
// a single increasing integer and has no opinion about what it means; deriving
// it means nobody has to remember to bump a second number by hand.
val crateVersionCode: Int = crateVersion.split('.', limit = 4).let { parts ->
    val n = { i: Int -> parts.getOrNull(i)?.takeWhile { it.isDigit() }?.toIntOrNull() ?: 0 }
    n(0) * 1_000_000 + n(1) * 1_000 + n(2)
}

// The release signing key, and a hand-edit this committed gen/ tree exists to
// carry -- like the CAMERA permission in AndroidManifest.xml, and like the
// version above (see .gitignore for why the tree is source rather than
// generated output). tauri.conf.json has no field for an Android signing
// config either.
//
// keystore.properties is NOT committed and is not expected to exist: it is
// written by .github/workflows/app-release.yml from repository secrets, for
// the length of one job. Everything that reads it is therefore conditional on
// the file being there, so that `mise run app:android:build` on a machine with
// no key keeps producing exactly the APK it always has. An unconditional
// signingConfig fails the whole Gradle configuration phase on a null
// storeFile, which would make the key a requirement for building at all.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "com.stan_ely.qrdrop"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.stan_ely.qrdrop"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", crateVersionCode.toString()).toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", crateVersion)
    }
    signingConfigs {
        if (keystoreProperties.containsKey("storeFile")) {
            create("release") {
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // Left unsigned when there is no keystore.properties, rather than
            // falling back to the debug key. A release APK signed with the
            // debug certificate installs and looks fine, and its signature
            // means nothing -- the debug key is generated per machine, shared
            // by every Android project on it, and its fingerprint can never go
            // in assetlinks.json. Better to produce something that plainly
            // will not install than something that quietly attests to nothing.
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")