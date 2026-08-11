# Mobile Setup — Human Steps

Everything in this file is a step only you can do — an account to create, a physical device to use, a review process to wait on. None of it can be automated or done from this build environment.

---

## Android

### 1. Get the Android SDK / build tooling
- Install [Android Studio](https://developer.android.com/studio) (includes the SDK, `adb`, and an emulator) **or** just the command-line tools if you don't want the IDE.
- Open `/android` in Android Studio once — it will generate `gradle/wrapper/gradle-wrapper.jar` automatically (a binary this build environment could not produce). Alternatively, with a system Gradle install: `cd android && gradle wrapper`.

### 2. Build the debug APK
```bash
cd android
./gradlew assembleDebug
```
Output: `android/app/build/outputs/apk/debug/app-debug.apk`.

### 3. Sideload it
Google Play rejects Accessibility Services used for app blocking (this is why the spec calls for sideloading, not a Play listing):
```bash
adb install app-debug.apk
```
Or copy the APK to the device and open it directly — you'll need to allow "install unknown apps" for whatever file manager/browser you use to open it.

### 4. Grant every permission during first-run onboarding
The app requests these in sequence when first opened (`MainActivity.requestOnboardingPermissions`) — each needs a manual tap, Android does not allow silently granting any of them:
- **VPN permission** (`VpnService.prepare` system dialog) — required for domain blocking.
- **Notification permission** (Android 13+/API 33+) — required for the session-complete notification to show.
- **Battery optimization exemption** — without this, some OEMs (Samsung, Xiaomi, OnePlus especially) will kill the foreground service in the background regardless of `START_STICKY`. If the system settings screen that opens looks different from stock Android, that's the OEM's own battery-management UI — grant the equivalent "no restrictions" / "allow background activity" option there too.
- **Accessibility Service** — this one is *not* auto-prompted (Android reserves the Accessibility settings screen navigation for the user, apps can only deep-link to Settings, not request it directly). Go to **Settings → Accessibility → Focus Lock → enable it** manually after first launch.
- **Device Admin** — prompted via `DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN`; tap "Activate."

### 5. Known-incomplete: pairing
Device-to-device pairing (SPAKE2 key exchange) is **not implemented** on Android in this build — see `DECISIONS.md`. The Devices tab UI exists but the underlying crypto call throws. Until this is implemented, an Android device generates its own standalone identity and cannot join a desktop's group. This needs either a hand-audited Kotlin port of the SPAKE2 math in `shared/src/pairing.ts`, or a vetted third-party JVM SPAKE2 library — neither was done here (see DECISIONS.md for why: hand-rolling untested elliptic-curve crypto was judged riskier than leaving the gap explicit).

---

## iOS

Every step below is a genuine prerequisite — none of `ios/DESIGN.md`'s architecture can be implemented, let alone tested, without all of these in place first.

### 1. Enroll in the Apple Developer Program
[developer.apple.com/programs](https://developer.apple.com/programs/) — $99/year, individual or organization. Takes anywhere from same-day to a few business days depending on entity type (an organization enrollment requires a D-U-N-S number and can take longer).

### 2. Request the Family Controls entitlement
This is the one Apple approval that gates the entire iOS build, and it is a genuinely slow, human-reviewed process:
- In your developer account, request the `com.apple.developer.family-controls` entitlement (via the [Feature request form](https://developer.apple.com/contact/request/family-controls-distribution) or the equivalent current path in the Developer portal — Apple has moved this form before, search "Family Controls" in the portal if the link above is stale).
- You'll need to describe the app's use case. Focus Lock's use case (self-imposed app/site blocking during a scheduled focus session, no parental/child relationship) is a legitimate but less common use of an API Apple primarily designed for parental controls — be explicit about that in the request so it isn't rejected as a mismatch.
- **This review takes days to weeks.** There is no way to expedite it, and no code quality changes that timeline. Submit this request as early as possible, independent of implementation progress — the entitlement approval and the actual coding work can and should happen in parallel once you start.
- You cannot test `FamilyControls`/`ManagedSettings`/`DeviceActivity` at all without this entitlement — Simulator doesn't support it, and a device build without the entitlement will fail authorization at runtime, not compile-time.

### 3. Xcode signing
- Once the entitlement is approved, add it to your App ID in the Developer portal.
- In Xcode, set your Team, and ensure the entitlement appears in `FocusLock.entitlements` for both the main app target and the `FocusLockMonitor` (DeviceActivityMonitor) extension target — the extension needs its own copy of relevant entitlements, it does not inherit the main app's.
- Provisioning profiles need to be regenerated after adding the entitlement (Xcode usually does this automatically with "Automatically manage signing," but confirm the entitlement actually appears in the generated profile — a stale cached profile is a common source of confusing runtime authorization failures).

### 4. A physical device
`FamilyControls` authorization does not work in Simulator at all. You need a real iPhone or iPad running iOS 16+, connected to your Apple Developer account as a registered test device (or via TestFlight once you have a build to distribute).

### 5. FCM / APNs (for the push-wakeup path described in the main spec)
- **APNs**: In the Developer portal, create an APNs Auth Key (`.p8` file) under Certificates, Identifiers & Profiles → Keys. Note the Key ID and your Team ID — the relay (or whatever backend sends the wakeup push) needs both plus the `.p8` file itself.
- **FCM** (used by the Android side, listed here since it's often set up in the same sitting): create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com), add an Android app with package name `com.focuslock.app`, download `google-services.json` into `android/app/`, and add the Firebase Cloud Messaging dependency to `android/app/build.gradle.kts` (not currently included in this build — push-as-wakeup was not implemented for Android in this pass either; the app relies on its persistent WebSocket connection plus the AlarmManager heartbeat instead, which is a reasonable v1 tradeoff but doesn't cover "phone's socket is dead" the way a real push wakeup would).

---

## Relay deployment (if you're self-hosting for real, not just running locally)

1. A small VM or container host anywhere — the relay is a single Docker container with a SQLite file, no external database needed.
2. `git clone` this repo, `cd relay`, `docker compose up -d` (see the caveat in `README.md` — this exact command was never run in the build environment, only reviewed).
3. Point every client's "Relay URL" setting at `wss://your-host:8787/ws` (use a reverse proxy like Caddy/nginx for TLS — the relay itself speaks plain `ws://`, not `wss://`, directly).
4. No further setup — no accounts, no API keys, no database migrations to run. The relay creates its SQLite schema on first start.
