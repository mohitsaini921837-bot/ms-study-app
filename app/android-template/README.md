# MS Study — android-template (fallback / reference copy)

The live Android project is `app/android/` (created in the VM with
`npx cap add android` + `npx cap sync android` — it worked, so this
template is a BACKUP, not the primary copy). If `app/android/` is ever
deleted or regenerated from scratch, copy these files back into place
as described below, then run `npx cap sync android`.

## Files in this folder

| File | Copy to (inside `app/android/`) |
|---|---|
| `java/com/kiara/msstudy/MsAccessPlugin.java` | `app/src/main/java/com/kiara/msstudy/MsAccessPlugin.java` |
| `java/com/kiara/msstudy/MsSessionStore.java` | `app/src/main/java/com/kiara/msstudy/MsSessionStore.java` |
| `java/com/kiara/msstudy/ApkInstallerPlugin.java` | `app/src/main/java/com/kiara/msstudy/ApkInstallerPlugin.java` |
| `java/com/kiara/msstudy/MainActivity.java` | `app/src/main/java/com/kiara/msstudy/MainActivity.java` (replaces the Capacitor-generated stub; registers both plugins before `super.onCreate()`) |
| `res/xml/provider_paths.xml` | `app/src/main/res/xml/file_paths.xml` (rename on copy — Capacitor generates this file with `cache-path` + `external-path` already; only replace it if it is missing) |
| `res/mipmap-*/ic_launcher*.png` | `app/src/main/res/mipmap-*/` (same names; generated from `logo-ms-liquid-glass.png`) |
| `AndroidManifest-snippet.xml` | entries to merge into `app/src/main/AndroidManifest.xml` (see below) |
| `build.gradle-signing-snippet.gradle` | signing block to merge into `app/build.gradle` (see below) |

## AndroidManifest entries (merge — do NOT replace the whole file)

Inside `<application>` (Capacitor already generates the FileProvider
below when `npx cap add android` runs; keep it if present):

```xml
<provider
    android:name="androidx.core.content.FileProvider"
    android:authorities="${applicationId}.fileprovider"
    android:exported="false"
    android:grantUriPermissions="true">
    <meta-data
        android:name="android.support.FILE_PROVIDER_PATHS"
        android:resource="@xml/file_paths"></meta-data>
</provider>
```

Outside `<application>`, with the other permissions:

```xml
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

## build.gradle signing snippet (merge into `app/build.gradle`)

Inside `android { ... }`, before `buildTypes`:

```gradle
signingConfigs {
    release {
        def ksFile = project.hasProperty('msstudy.keystore.file') ? project.property('msstudy.keystore.file') : null
        if (ksFile) {
            storeFile file(ksFile)
            storePassword project.hasProperty('msstudy.keystore.password') ? project.property('msstudy.keystore.password') : ''
            keyAlias project.hasProperty('msstudy.key.alias') ? project.property('msstudy.key.alias') : 'msstudy'
            keyPassword project.hasProperty('msstudy.key.password') ? project.property('msstudy.key.password') : ''
        }
    }
}
```

And in `buildTypes { release { ... } }` add:

```gradle
if (project.hasProperty('msstudy.keystore.file')) {
    signingConfig signingConfigs.release
}
```

The keystore file itself (`~/workspace/ms-study/keystore/msstudy-release.keystore`,
alias `msstudy`) is NEVER copied into the repo — the GitHub workflow
recreates it from the `KEYSTORE_BASE64` repo secret at build time.

## GitHub workflow note

If `app/android/` is NOT committed to the repo, the workflow
(`.github/workflows/android.yml`) runs `npx cap add android` first,
then copies this template's Java + res files into place before the
Gradle build. If `app/android/` IS committed, the workflow just runs
`npx cap sync android`.
