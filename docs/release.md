# Android release (private APK)

How to build, sign, install and update the app outside Google Play.
Google Cloud setup is in [google-cloud-setup.md](google-cloud-setup.md).

## Builds and signing

Builds run on EAS (Expo's build service) from [`eas.json`](../eas.json). Both
profiles produce an **APK** (`android.buildType: "apk"`) for direct install.

| Profile | What it is | Signed with |
|---|---|---|
| `development` | Development build (dev client); loads JS from `npx expo start` | EAS-managed keystore |
| `production` | Release APK; JS bundled in, no dev menu | EAS-managed keystore |

- With no extra configuration, EAS signs both profiles with the same
  keystore, so both builds have the same SHA-1 and need only one Android
  OAuth client.
- A local `npx expo run:android` build is signed with the Android SDK debug
  keystore instead. That has a different SHA-1 and needs its own OAuth client
  (see google-cloud-setup.md).
- Version numbers: `cli.appVersionSource` is `remote`, and the `production`
  profile has `autoIncrement: true`. EAS therefore raises `versionCode` on
  every release build, which Android requires before it will install an
  update. The user-visible version stays `expo.version` in `app.json`
  (currently `1.0.0`); raise it by hand when you want a new version name.

## One-time setup

1. Create a free Expo account at expo.dev.
2. In the project directory:
   ```bash
   npx eas-cli@latest login
   npx eas-cli@latest init
   ```
   `init` links the project to your account and writes `owner` and
   `extra.eas.projectId` into `app.json`. Commit that change.
3. Complete the Google Cloud steps 1–3 in google-cloud-setup.md: one project,
   Drive and Sheets APIs enabled, consent screen with your account as a test
   user.

## Build the release APK

```bash
npx eas-cli@latest build --platform android --profile production
```

- On the first build, answer **Yes** to "Generate a new Android Keystore?".
  EAS creates the keystore, stores it with the project and reuses it for
  every later build.
- When the build finishes, the CLI prints a link to the build page on
  expo.dev, where the `.apk` can be downloaded.

For a development build, use `--profile development`, then start the JS
server with `npx expo start` and open the app on the phone.

The first EAS build is also the first time the Kotlin module in
`modules/google-authorization` is compiled. It has not been built on this
machine (no JDK or Android SDK here). If the build fails in that module, the
build log on expo.dev shows the compiler error.

## Register the signing fingerprint with Google

```bash
npx eas-cli@latest credentials --platform android
```

1. Choose the `production` profile.
2. The keystore summary includes its **SHA-1 fingerprint**. It is also shown
   on expo.dev under the project's credentials.
3. In Google Cloud (Google Auth Platform → Clients → Create client →
   Android), create a client with:
   - package `dev.expenses.tracker`
   - that SHA-1
4. Record the SHA-1 in the table in google-cloud-setup.md.

Without this step, "Connect Google" ends with "This build isn't set up with
Google yet".

## Install on the phone

1. Open the build page link on the phone and download the APK.
   Alternatively, with USB debugging: `adb install -r path/to/app.apk`.
2. Allow the browser or file manager to **install unknown apps** when
   Android asks (Settings → Apps → Special app access → Install unknown apps).
3. Open the app and connect Google. Approve the Drive permission on Google's
   consent screen.

Play Protect may warn about an app from an unknown developer. That is
expected for a private APK; choose to install anyway.

## Update to a new version

1. Build again:
   `npx eas-cli@latest build --platform android --profile production`.
   The `versionCode` goes up automatically.
2. Install the new APK **over** the existing app. Do not uninstall first.
   Android accepts the update because the package name and signing key are
   the same, and the app keeps its local data.

Before any uninstall or reinstall, open the app and make sure nothing is
waiting to be saved (no "Saved on this phone, not yet in Google Sheets"
items). `android.allowBackup` is `false`, so uninstalling deletes the local
database:

- Confirmed expenses come back from the sheet on the next refresh.
- Expenses saved on the phone but not yet sent to Google are lost.

## Keeping the signing key

Every future update must be signed with **the same keystore**. Android
refuses to install an update signed with a different key ("App not
installed"). The only way past that is to uninstall, which loses unsent local
data, and to register a new SHA-1 with Google.

- **Primary copy:** EAS keeps the keystore with the Expo project. Any build
  from this project, on any computer logged in to the same Expo account,
  reuses it automatically.
- **Offline backup (do this once, after the first build):**
  1. Run `npx eas-cli@latest credentials --platform android`.
  2. Choose `production` → "credentials.json: Upload/Download credentials
     between EAS servers and your local json" → "Download credentials from
     EAS to credentials.json".
  3. This writes `credentials.json` (passwords and alias) and the keystore
     file into the project directory.
  4. Move both into a password manager or encrypted storage, then delete
     them from the project directory.
  5. They are git-ignored (`credentials.json`, `*.jks`, `*.keystore`) and
     must never be committed.
- **Restoring:** put `credentials.json` and the keystore back, then upload
  them with the same `eas credentials` menu ("Upload credentials from
  credentials.json to EAS").

## Building on your own computer instead

```bash
npx eas-cli@latest build --platform android --profile production --local
```

- Runs on macOS or Linux.
- Needs the Android SDK and NDK and a JDK installed locally. Use the JDK
  version required by React Native 0.88.
- Still needs `eas login`: EAS supplies the signing credentials.
- The APK is written to the project directory.
