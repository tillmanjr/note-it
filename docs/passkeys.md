# Passkeys (2c-2)

Decided with the user on 2026-11-20. This replaces the setup and device codes, and the long-lived device tokens, from [sync.md](sync.md).

## Decisions

| Area | Decision |
|---|---|
| Credential | Each device creates **its own device-bound passkey** (Windows Hello on desktop; the OS passkey sheet on mobile later). No synced or shared passkeys. |
| Joining | Three independent steps, each just a status change on the server: **request** (device), **approve** (admin), **pick up** (device, next time it's open). Nothing has to happen at the same time. The first device joins the same way. |
| Approver | **The droplet's shell only**: `notes-admin` over SSH, which is protected by the `notes_droplet` key. The app can't approve, deny or revoke. |
| Match code | A request shows a short code (e.g. `K7F-2QM`, from the credential id) on the device and in `notes-admin pending`. Approve only the request whose code matches, because anyone can submit a request. |
| Re-check | The passkey signs in **once per app launch**. The server returns an **access token kept only in memory**, valid up to 24 h. Nothing reusable is stored on disk, so the OS keychain isn't needed. |
| Prompt | Native OS API (Windows `webauthn.dll` from Rust), not the system browser, so a launch is one Windows Hello prompt with no browser tab. The browser dev build uses `navigator.credentials` on `localhost`. |
| Device-bound check | The **server** refuses any passkey whose authenticator reports it can be backed up or synced (WebAuthn backup flags), so 1Password, iCloud and Google passkeys are refused. The app asks Windows for no particular authenticator, because some Windows builds reject the "platform only" option outright. |
| RP ID | `notes.tillmanjr.com` in production. `localhost` in development, so dev and production passkeys never mix. The server sends its RP ID; the client never hard-codes it. |
| Limits | Pending requests expire after 7 days. Requests and sign-ins are rate-limited per IP. |

## States

`pending` → `approved` or `denied`. `approved` → `revoked`. Only `approved` devices can sign in. Revoking ends the device's sessions and closes its sockets at once.

## Pieces

- **Server:** a new migration for credentials, challenges and sessions. Existing token devices are revoked, and the code tables stop being used. `@simplewebauthn/server` verifies registrations and sign-ins.
  - `POST /devices/request` and `POST /devices/request/:id/credential`: register a passkey and create a pending request.
  - `GET /devices/request/:id`: the request's status, polled by the device.
  - `POST /auth/challenge` and `POST /auth/session`: sign in and get an access token.
  - `src/admin.ts` (`notes-admin`): `pending`, `approve <code>`, `deny <code>`, `devices`, `revoke <id>`.
- **Client:** the sync config keeps only the server URL, device id, credential id and request id. The access token lives in memory. A 401 means "sign in again"; the client never guesses.
- **Tauri:** a Rust command wraps `WebAuthNAuthenticatorMakeCredential` and `GetAssertion` (`windows` crate). It builds the `clientDataJSON` itself, with the server's origin.
- **UI:** "Connect to server…" becomes "Request access…" (server and device name), then shows the match code and "Waiting for approval". "Add a device…" and the in-app device revoke go away.

## Moving over

The one device connected today gets cut off by the migration. It requests access again and is approved with `notes-admin`. Its notes are local, so nothing is lost; it re-syncs as a newly joined device.

## Windows setup

With a third-party passkey provider installed (1Password here), Windows can have **Settings → Accounts → Passkeys → Advanced options → Save passkeys to this Windows device** switched off. Then Windows offers only a phone or a security key, and asking for Windows Hello fails with "The parameter is incorrect." Turn that option on (the other provider can stay on) and pick this Windows device in the "Choose where to save your passkey" dialog.
