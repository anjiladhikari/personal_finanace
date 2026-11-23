# Google Cloud setup (Android)

How this app is registered with Google, and what must be configured before
"Connect Google" works on a device.

## How authorization works

- The app calls Google Play services' **AuthorizationClient** through the local
  native module in `modules/google-authorization`. Play services shows Google's
  account and consent screens and returns a short-lived **access token**.
- Google recognises the app by its **Android package name + signing-certificate
  SHA-1**. There is no client secret, web client ID, API key,
  `google-services.json` or service account anywhere in the app or repo.
- Tokens are cached and refreshed by Play services. The app keeps them in memory
  only; SQLite stores just the account's OpenID `sub`, its email (as the account
  hint) and the spreadsheet/tab IDs.

## Fixed identifiers

| Item | Value | Where it is set |
|---|---|---|
| Android package (applicationId) | `dev.expenses.tracker` | `app.json` → `android.package` |
| OAuth scopes | `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/drive.file` | `src/google/scopes.ts` |
| APIs called | Google Drive API v3, Google Sheets API v4, OpenID userinfo | `src/google/*.ts` |
| Spreadsheet | "My Expenses", tab "Expenses", header `Date \| Description \| Amount \| Category \| Expense ID` | `src/domain/sheetContract.ts` |
| Drive app properties (private to this Cloud project) | `expenseTrackerRole=expenses`, `expenseTrackerSchema=1`, `expenseTrackerTabId=<sheetId>` | `src/domain/sheetContract.ts` |

All three scopes are classified by Google as **non-sensitive**, so no Google
app verification is required.

## One-time setup in Google Cloud console

Use **one** Cloud project for every build of this app. `drive.file` access and
the private app properties belong to the project: a build registered under a
different project cannot see the existing "My Expenses" file.

1. **Create a project** (any name).
2. **Enable APIs**: *Google Drive API* and *Google Sheets API*
   (APIs & Services → Library), or:
   `gcloud services enable drive.googleapis.com sheets.googleapis.com`
   Without them the app shows "This build isn't set up with Google yet".
3. **Consent screen** (Google Auth Platform → Branding, Audience, Data access):
   - User type: **External**.
   - App name and support email: your choice. No logo needed.
   - Data access: add the three scopes above.
   - Audience: while in **Testing**, add your Google account as a test user.
     For long-term personal use, consider publishing to **In production**;
     with only non-sensitive scopes this does not need verification.
4. **Android OAuth clients** (Google Auth Platform → Clients → Create client →
   Android): create **one client per signing certificate**, each with
   package name `dev.expenses.tracker` and that certificate's SHA-1.
   Do **not** create or download a client secret; Android clients have none.

## Signing fingerprints to register

Fill in this table as builds are set up. SHA-1 values are not secret, but
keystores are: never commit `*.jks` / `*.keystore` (already in `.gitignore`).

| Build | Keystore | How to read the SHA-1 | SHA-1 | Android OAuth client |
|---|---|---|---|---|
| Local development build (`npx expo run:android`) | `~/.android/debug.keystore` (created by the Android SDK) | `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`, or `cd android && ./gradlew signingReport` | _to fill_ | _to create_ |
| EAS development build | EAS-managed keystore | `npx eas-cli@latest credentials -p android` | _to fill_ | _to create_ |
| Release APK (EAS `production` profile) | EAS-managed keystore, generated 22 Nov 2026 (project `@anjil07/expense-tracker`) | `npx eas-cli@latest credentials -p android`, or read from the APK's signing certificate | `F4:04:2C:68:24:D9:F9:3A:ED:A7:EC:23:EE:71:AE:7F:72:9C:51:AD` | _to create_ |

If a build's SHA-1 is not registered, AuthorizationClient fails with
`DEVELOPER_ERROR` and the app shows "This build isn't set up with Google yet".
Re-signing the app with a new keystore needs a new Android client in the
**same** project.

## Device acceptance checks

Run these on an Android development build after the steps above. Unit tests
cover the same flows against a fake Google backend; these confirm the real one.

1. **First connection**: fresh install → Connect Google → pick account →
   approve. Expect Add expense. In Drive there is exactly one "My Expenses"
   with an `Expenses` tab and the header row, frozen.
2. **Repeated setup**: Account → Check connection. Expect "Connected as …";
   still one file; header unchanged.
3. **Rename**: rename the file and the tab in Google Sheets → Check
   connection. Expect "Connected"; no new file or tab.
4. **Reinstall recovery**: uninstall, reinstall the same build, Connect Google
   with the same account. Expect the existing file to be reused (no new file).
5. **Cancelled authorization**: tap Connect, then back out of Google's screen.
   Expect "Google connection was cancelled" and a working Connect button.
6. **Drive permission unticked**: on the consent screen, untick the Drive
   permission. Expect "Drive permission is needed".
7. **Revoked access**: myaccount.google.com → Security → Third-party
   connections → remove the app → Account → Check connection. Expect
   "Google access needs to be renewed"; Reconnect restores it with the same
   file. (Confirms `drive.file` access to app-created files returns after
   re-consent.)
8. **Missing file**: delete "My Expenses" permanently (also from Trash) →
   Check connection. Expect "The app can't find …"; Create a new spreadsheet
   works. Trashed-only: expect the "is in your Google Drive trash" state and
   recovery after restoring it.
9. **Wrong account**: on a phone with two Google accounts, Account → Use a
   different Google account → pick the other account. Expect the "This phone
   is set up for …" state; switching needs confirmation and is refused while
   expenses are waiting to be saved for the original account.
