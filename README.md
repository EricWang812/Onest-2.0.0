# Onest

A cross-device focus system: a countdown timer that blocks social media and games system-wide on every paired device simultaneously, and logs how long you actually worked. No accounts — devices pair with a 6-digit code over a self-hostable relay.

**You cannot stop a running session.** No pause, no cancel, no "end early," on any device, on purpose. Read `DECISIONS.md` before relying on this for anything — it documents every judgment call, every gap, and everything that could not be verified in the environment this was built in (no admin rights, no macOS, no Android SDK, no iOS device).

> Renamed from "Focus Lock" mid-project — some internal identifiers (Windows Firewall rule names, hosts-file markers, npm package scope, the Android package name) were deliberately left as `FocusLock`/`focuslock` rather than renamed; see `DECISIONS.md` for why each one was kept.

## Repository layout

| Path | What it is | Status |
|---|---|---|
| `/shared` | Protocol types, the blocklist, crypto helpers — TypeScript, imported by relay + desktop | Complete, tested (21/21) |
| `/relay` | Self-hostable sync relay (Node + Fastify + WebSocket + SQLite) | Complete, tested (6/6) |
| `/desktop` | Windows/macOS app — Electron+React UI, a privileged daemon, a watchdog | Complete, tested (20/20). Windows verified end-to-end; macOS written, unverified — no macOS available |
| `/android` | Kotlin client, sideload APK | Complete source, unbuilt — no Android SDK available. SPAKE2 pairing not implemented — see `DECISIONS.md` |
| `/ios` | Design document only, by design — see `ios/DESIGN.md` | Not code |

## Install

### Windows: single-file installer (fastest path on this machine)

`desktop/release/Onest-Setup.exe` (built via Inno Setup — see `DECISIONS.md` for why not the NSIS path `dist:win` normally produces) installs everything needed to run Onest entirely on one Windows machine in one step: the UI, plus three Windows Services — `OnestRelay`, `OnestDaemon`, `OnestWatchdog` — pre-wired to talk to each other on `localhost` so pairing and sessions work with no manual relay setup. The app itself (`Onest.exe`) requires Administrator on every launch, not just install — see `DECISIONS.md` Follow-up #10 for why (its daemon connection depends on it).

- **Requires Node.js 22+ already installed** (the installer checks for it via `where node` and refuses to continue if missing — get it from [nodejs.org](https://nodejs.org) first).
- **Requires Administrator** (registers Windows Services) — you'll get a UAC prompt.
- Double-click it, click through the wizard, done. Uninstall from "Add or Remove Programs" the normal way — it stops and removes all three services first. If you had an older `FocusLock-Setup.exe` install, this installer migrates it automatically (stops/removes the old `FocusLock*` services, moves the old `%ProgramData%\FocusLock` data directory — including your device's signing keypair — forward to `%ProgramData%\Onest`, and removes the old install directory).
- Rebuild it yourself any time with `cd desktop && npm run build && node build/build-node-bundles.mjs && npx electron-builder --win dir && npm run patch:exe && "path\to\ISCC.exe" build/onest.iss`.

### Relay (do this first if you want cross-device sync, and aren't using the single-file installer above)

```bash
cd relay
docker compose up -d
```

This was written and reviewed but never built/run in this environment (no Docker available here — see `DECISIONS.md`). If you don't want to run a relay at all, the desktop app works standalone; a running session just won't sync to other devices until LAN-direct mode (mDNS) is implemented, which is scoped but not built in this pass.

To run the relay without Docker:

```bash
cd relay
npm install && npm run build
PORT=8787 RELAY_DB_PATH=./data/relay.sqlite npm start
```

### Desktop (Windows)

1. `cd desktop && npm install`
2. `npm run build` — compiles the daemon/watchdog, builds the Electron main/preload, bundles the renderer, and verifies the preload bundle is real CJS (not broken ESM — see `DECISIONS.md` Follow-up #11).
3. `npm run dist:win` — packages via electron-builder. **In this build environment, packaging succeeds (`release/win-unpacked/Onest.exe`) but the final NSIS installer step requires Windows Developer Mode or an elevated (Administrator) shell** — see `DECISIONS.md` for exactly why (a `winCodeSign` tooling archive electron-builder downloads contains symlinks, and creating those needs `SeCreateSymbolicLinkPrivilege`). On a normal Windows dev machine this resolves itself; run `npm run dist:win` there to get `Onest-Setup-<version>.exe`.
4. The installer registers `OnestRelay`, `OnestDaemon`, and `OnestWatchdog` as Windows Services (LocalSystem, auto-restart) via NSSM — see `desktop/build/onest.iss`. **Requires Node.js 22+ already installed on the target machine** (the installer does not bundle a portable Node runtime — see `DECISIONS.md`).
5. First run: the app generates a device keypair and a `group_id` automatically. No account, no sign-in.

### Desktop (macOS)

Written (`desktop/src/daemon/enforcement-macos.ts`, `desktop/build/com.onest.daemon.plist`, `desktop/build/pkg-scripts/postinstall`), never built or run — no macOS available in this environment. Expect macOS enforcement to be meaningfully weaker than Windows (SIP + TCC constraints) — see `DECISIONS.md` for the specifics before relying on it.

### Android

```bash
cd android
./gradlew assembleDebug
```

**Not run in this environment — no Android SDK.** `gradlew`/`gradlew.bat` need `gradle/wrapper/gradle-wrapper.jar`, a binary this environment could not produce; open the project in Android Studio once, which generates it automatically, or run `gradle wrapper` yourself first. See `SETUP-MOBILE.md` for the full sideload + permission-grant walkthrough, and `DECISIONS.md` for what is and isn't implemented (notably: pairing does not work yet — SPAKE2 was not hand-rolled for Android, see `DECISIONS.md`). The Android package (`com.focuslock.app`) was deliberately not renamed — see `DECISIONS.md`.

### iOS

Not built. See `ios/DESIGN.md` and `SETUP-MOBILE.md`.

## First run / pairing

1. Install the desktop app on your first device. It generates a `group_id` and a shared Ed25519 signing keypair — this is the group identity every paired device will end up sharing.
2. Go to **Devices → Pair new device**. A 6-digit code and QR code appear, valid for 5 minutes, one use.
3. On the second device, enter the code (Android: the Devices tab has a code-entry field, though the underlying crypto call currently throws — see `DECISIONS.md`; desktop-to-desktop pairing between two instances is the fully working path today).
4. Both devices run a SPAKE2 key exchange through the relay — the relay itself never sees the code or the resulting key, only opaque bytes. Once confirmed, the host encrypts the group's private key and sends it to the joiner over the same channel.
5. Starting a session on either device now starts it on both, within ~10 seconds (relay-connected) or on next reconnect (offline).

## Uninstall / recovery

**Windows** (run as Administrator):
```powershell
sc.exe stop OnestWatchdog
sc.exe stop OnestDaemon
sc.exe stop OnestRelay
sc.exe delete OnestWatchdog
sc.exe delete OnestDaemon
sc.exe delete OnestRelay
netsh advfirewall firewall delete rule name="FocusLock-DoH-1.1.1.1"
netsh advfirewall firewall delete rule name="FocusLock-DoH-8.8.8.8"
ipconfig /flushdns
```
The firewall rule names above are correct as written, not a leftover typo — they were deliberately kept as `FocusLock-*` through the rename rather than renamed, to avoid orphaning rules already created by an install before the rename (see `DECISIONS.md`). Then edit `C:\Windows\System32\drivers\etc\hosts` and remove the block between `# FOCUSLOCK-BEGIN` and `# FOCUSLOCK-END` (also kept unrenamed for the same reason) — or restore from a backup. Uninstalling via the normal Windows uninstaller (or via "Add or Remove Programs" if you used `Onest-Setup.exe`) runs the same service cleanup automatically.

**If you're locked out and need to do this from Safe Mode / a recovery environment:** boot into Safe Mode with Networking, open an elevated Command Prompt, and run the same commands above — `sc.exe` and hosts-file editing both work without the daemon running.

**macOS** (untested — written for a real deployment, not verified here):
```bash
sudo launchctl unload /Library/LaunchDaemons/com.onest.daemon.plist
sudo launchctl unload /Library/LaunchDaemons/com.onest.watchdog.plist
sudo rm /Library/LaunchDaemons/com.onest.daemon.plist /Library/LaunchDaemons/com.onest.watchdog.plist
sudo pfctl -a focuslock -F all
sudo dscacheutil -flushcache
```
The `pfctl -a focuslock` anchor name is correct as written — kept unrenamed for the same reason as the Windows firewall rules above. Then edit `/etc/hosts` and remove the `# FOCUSLOCK-BEGIN`...`# FOCUSLOCK-END` block.

**Android:**
```bash
adb shell dpm remove-active-admin com.focuslock.app/.admin.FocusLockDeviceAdminReceiver
adb uninstall com.focuslock.app
```
(Device admin is also auto-deactivated when a session completes normally — see `DECISIONS.md`. The Android package name was deliberately not renamed.)

## Platform permission notes

- **Windows**: the installer needs Administrator to register services and write firewall rules, and **`Onest.exe` itself now requires Administrator on every launch** (its daemon connection depends on it — see `DECISIONS.md` Follow-up #10).
- **macOS**: the daemon runs as root via launchd. Process-kill and some hosts-file protections may additionally prompt for Full Disk Access / other TCC grants on modern macOS — untested here, see `DECISIONS.md`.
- **Android**: Accessibility Service, VPN (`VpnService.prepare` user consent dialog, once), battery-optimization exemption, Device Admin, and (API 33+) notification permission are all requested during first-run onboarding (`MainActivity.requestOnboardingPermissions`). None of these can be silently granted — Android requires user interaction for each.
- **iOS**: FamilyControls authorization, requested via `AuthorizationCenter` — see `ios/DESIGN.md` §2 and §7 for what this can and cannot enforce.

## Tests

```bash
npm test                    # from repo root — runs shared + relay + desktop suites (npm workspaces)
```

47/47 passing as of this build: `shared` 21, `relay` 6, `desktop` 20 (including a real process-kill/respawn integration test — see `DECISIONS.md`). Android/iOS have no automated tests since neither can be built/run here.

## Everything else

`DECISIONS.md` is the real documentation — every judgment call, every found-and-fixed bug, every gap, organized by package, written as it happened rather than reconstructed after the fact. Read it before trusting any specific claim in this README.
