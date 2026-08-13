plugins {
    kotlin("jvm") version "2.3.10"
    application
}

group = "honeypot"
version = "1.0.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("dev.kord:kord-core:0.18.1")
    implementation("org.xerial:sqlite-jdbc:3.53.2.1")
}

kotlin {
    jvmToolchain(17)
}

base {
    archivesName.set("honeypot")
}

application {
    mainClass.set("HoneypotKt")
}

tasks.jar {
    archiveFileName.set("honeypot.jar")
    manifest {
        attributes["Main-Class"] = "HoneypotKt"
        attributes["Multi-Release"] = "true"
    }
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) }) {
        exclude("META-INF/MANIFEST.MF", "META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA")
        exclude("module-info.class", "META-INF/versions/*/module-info.class")
    }
}
