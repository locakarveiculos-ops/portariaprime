import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Assinatura release: keystore FORA do repositório (android/keystore.properties ou variáveis de CI).
// Perder a keystore impede atualizar aparelhos já provisionados — guarde com backup.
// PP_KIOSK_PROPERTIES aponta para um keystore.properties fora do projeto (preferido: a chave nunca entra aqui).
val ks = Properties().apply {
    val f = System.getenv("PP_KIOSK_PROPERTIES")?.let { file(it) } ?: rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun secret(name: String): String? = (ks.getProperty(name) ?: System.getenv("PP_KIOSK_$name"))?.takeIf { it.isNotBlank() }

android {
    namespace = "br.com.portariaprime.kiosk"
    compileSdk = 35

    defaultConfig {
        applicationId = "br.com.portariaprime.kiosk"
        minSdk = 26          // Android 8.0: Keystore EC, setLockTaskFeatures só no 28+ (degrada com aviso)
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        // Origem do sistema web e do backend. HTTPS obrigatório; sem override em release.
        buildConfigField("String", "APP_ORIGIN", "\"${project.findProperty("ppAppOrigin") ?: "https://portariaprime.vercel.app"}\"")
        buildConfigField("String", "SUPABASE_ORIGIN", "\"${project.findProperty("ppSupabaseOrigin") ?: "https://zehijyqgqkouzhldeqio.supabase.co"}\"")
    }

    signingConfigs {
        if (secret("STORE_FILE") != null) create("release") {
            storeFile = file(secret("STORE_FILE")!!)
            storePassword = secret("STORE_PASSWORD")
            keyAlias = secret("KEY_ALIAS")
            keyPassword = secret("KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            buildConfigField("boolean", "LAB_LOOPBACK", "false")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            // Laboratório: com -PppLab=true aponta para a stack local por adb reverse (http://127.0.0.1).
            // Release nunca aceita cleartext nem loopback.
            val lab = project.findProperty("ppLab") == "true"
            buildConfigField("boolean", "LAB_LOOPBACK", lab.toString())
            if (lab) {
                buildConfigField("String", "APP_ORIGIN", "\"http://127.0.0.1:3017\"")
                buildConfigField("String", "SUPABASE_ORIGIN", "\"http://127.0.0.1:54321\"")
                resValue("bool", "lab_cleartext", "true")
            }
        }
    }
    buildFeatures { buildConfig = true; resValues = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
    lint { abortOnError = true; checkReleaseBuilds = true; disable += setOf("ExpiredTargetSdkVersion") }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")   // org.json real nos testes JVM (o android.jar só tem stubs)
}
