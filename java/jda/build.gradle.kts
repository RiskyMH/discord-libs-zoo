plugins {
    java
    application
}

group = "honeypot"
version = "1.0.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("net.dv8tion:JDA:6.5.0")
    implementation("org.xerial:sqlite-jdbc:3.53.2.1")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

base {
    archivesName.set("honeypot")
}

application {
    mainClass.set("honeypot.Honeypot")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}

tasks.jar {
    archiveFileName.set("honeypot.jar")
    manifest {
        attributes["Main-Class"] = "honeypot.Honeypot"
        attributes["Multi-Release"] = "true"
    }
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) }) {
        exclude("META-INF/MANIFEST.MF", "META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA")
        exclude("module-info.class", "META-INF/versions/*/module-info.class")
    }
}
