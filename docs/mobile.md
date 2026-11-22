# Mobile (milestone 3)

Decided with the user on 2026-11-20. Builds on [design.md](design.md), [passkeys.md](passkeys.md) and [vault.md](vault.md).

## Decisions

| Area | Decision |
|---|---|
| Devices | **Android tablet first**, iPhone later (needs a Mac or a macOS build service, and the Apple Developer account). |
| Shell | Capacitor 8 wrapping the desktop app's web UI (`apps/desktop`), not a second UI. A `capacitor` platform adapter supplies storage, files and the device key. |
| Scope | Everything the desktop does except Evernote import: notebooks, tags, search, editing with the same editor, vault sections, offline, sync. Plus **Share to Notes** from other apps. |
| Layout | Tablet: the desktop layout adapted for touch (bigger targets, the notes list collapsing beside the note in portrait). |
| Sign-in | A **device key** in the Android Keystore (StrongBox when the tablet has it): P-256, can't be exported or synced, and every use needs a fingerprint, face or the screen lock (BiometricPrompt). |
| Install | Built on this PC with Android Studio and installed over USB (or Wi-Fi debugging). The release signing key is created on this PC, kept with the SSH keys and in 1Password, and never goes to GitHub. |

## Device key as a passkey

The app answers the server in the WebAuthn format, like Windows Hello does, so **the server, the protocol and the admin flow stay as they are** (request → `notes-admin approve` → sign in once per launch):

- **Request access:** the Keystore creates a key. The app builds a WebAuthn registration around its public key: `fmt: "none"`, flags UP and UV, backup flags off, client data naming the server's origin. The server's device-bound check passes because the key can't be backed up.
- **Sign in:** the app builds the authenticator data and client data for the server's challenge, and the Keystore signs `authenticatorData ‖ SHA-256(clientDataJSON)` after the BiometricPrompt. That's an ordinary ES256 assertion.
- The building is shared code (`packages/core/src/nativeKey.ts`) over a two-call native interface (`createKey`, `sign`), and is tested end to end against the real server with a software key.
- As with Windows Hello, the server trusts the device's claim of user verification (attestation `none`). Here the Keystore enforces it: the key won't sign without a fresh biometric or screen-lock check.

## Pieces

- `packages/core/src/nativeKey.ts`: WebAuthn framing for a native key.
- `apps/desktop/src/platform/capacitor.ts`: SQLite (`@capacitor-community/sqlite`), attachment files (`@capacitor/filesystem`), the device key and incoming shares.
- `apps/mobile`: the Capacitor project (Android), its Keystore and share plugins (Java). Its web assets are the desktop build.
- The server allows the app's origin (`https://localhost`) for CORS.

## Build and install (Windows)

1. Install Android Studio (`winget install Google.AndroidStudio`), open it once and accept the setup wizard (Android SDK).
2. Install Java 21 (`winget install Microsoft.OpenJDK.21`). The build tools (Gradle 8.14) can't run on Android Studio's bundled Java 25. In Android Studio: Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JDK → the Microsoft 21 JDK.
3. On the tablet: Settings → About → tap Build number 7 times; then Developer options → USB debugging on. Connect it by USB and allow this PC.
4. `npm run sync -w @tdjr/mobile` builds the web UI and copies it into the Android project.
5. `npm run open -w @tdjr/mobile` opens Android Studio; pick the tablet and press Run. Or from PowerShell in `apps/mobile/android`, without Android Studio:
   ```
   $env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.13.102-hotspot"; $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
   .\gradlew.bat installDebug
   ```
6. In the app: ⚙ → Request access… with `https://notes.tillmanjr.com`, then `sudo notes-admin approve <CODE>` on the droplet. Sign-in asks for a fingerprint, face or the screen lock.

The first builds are debug builds, signed with Android Studio's own debug key. A release signing key (kept on this PC and in 1Password, never in the repo) comes when the app is used day to day.

**Server side (once, after merging):** the droplet must allow the app's origin, `https://localhost` (`CORS_ORIGINS` in `deploy/files/notes.env`). From PowerShell in the repo, on an up-to-date `main`:

```
age-keygen -y $HOME\.ssh\notes_backup.age
scp -i ~/.ssh/notes_droplet -r deploy tillman@notes.tillmanjr.com:
ssh -i ~/.ssh/notes_droplet tillman@notes.tillmanjr.com
```

The first line prints the backup public key (`age1…`, not secret). On the droplet:

```
sudo bash deploy/02-install.sh <that age1… key> [the same Let's Encrypt email as the first install, if you gave one]
sudo systemctl restart notes-server
sudo grep CORS_ORIGINS /etc/notes/env
curl -s -o /dev/null -D - -X OPTIONS -H 'Origin: https://localhost' -H 'Access-Control-Request-Method: POST' https://notes.tillmanjr.com/health | grep -i access-control-allow-origin
```

The last line should print `access-control-allow-origin: https://localhost`.
