# Focus Lock — iOS Design Document

**Status: design document, not code.** Per the project brief's explicit priority order, iOS is last and lowest priority, and is gated behind an Apple entitlement request that takes weeks of human review regardless of code quality — it cannot ship on the same timeline as the rest no matter what's built now. Phases 1–3 (relay, desktop, Android) are complete and tested to the extent this environment allows; this document is the deliverable for phase 4, per the brief's own stated preference ("leave `/ios` as a written design document... not stub code").

This is not a hand-wave. It's specific enough that implementation should be close to mechanical once someone has a paid Apple Developer account, the FamilyControls entitlement, and a physical device (all three are hard requirements — none of this works in Simulator).

---

## 1. Why iOS is structurally different from every other platform here

Every other client in this project (desktop, Android) enforces blocking itself: it owns a privileged process, rewrites system state (hosts file, firewall rules, a VPN tunnel it controls), and polls for violations. iOS permits none of that to a third-party app. There is no equivalent of "elevated daemon that rewrites the hosts file" on iOS — sandboxing forbids it categorically, not as a matter of difficulty.

**Apple's Screen Time / Family Controls stack is the only sanctioned path, and it inverts the whole architecture:** instead of Focus Lock enforcing blocks itself, Focus Lock *declares* what should be shielded and *schedules* when, and the OS (specifically `ManagedSettings` + the `com.apple.ManagedSettings` system daemon) does the actual enforcement, entirely outside Focus Lock's process, in a part of the OS Focus Lock cannot see or influence once configured. This is actually *stronger* than the desktop's own-process enforcement in one respect — the app doesn't need to stay alive, be a daemon, or defend itself from being killed, because it was never the thing doing the blocking — but weaker in another, more important respect covered in §7.

## 2. Framework stack

| Framework | Role |
|---|---|
| `FamilyControls` | Requests the one authorization (`AuthorizationCenter.shared.requestAuthorization(for: .individual)`) that unlocks everything else. Requires the `com.apple.developer.family-controls` entitlement (see SETUP-MOBILE.md — Apple-side approval, not a code problem). |
| `ManagedSettings` | The actual shield. A `ManagedSettingsStore` holds `shield.applications` / `shield.applicationCategories` / `shield.webDomains` — setting these properties is what blocks something. Persists even if Focus Lock is not running. |
| `DeviceActivity` + `DeviceActivityMonitor` (extension) | Schedules *when* the shield is active. A `DeviceActivitySchedule` (start/end `DateComponents`) is registered via `DeviceActivityCenter.shared.startMonitoring(_:during:)`; the extension's `intervalDidStart`/`intervalDidEnd` callbacks flip the `ManagedSettingsStore`'s shield properties on/off. This is what makes blocking survive the app not running — the extension is a separate, OS-managed process. |
| `FamilyActivityPicker` (SwiftUI) | The *only* UI Apple provides for a user to select apps/categories to shield. Returns a `FamilyActivitySelection` of opaque `ApplicationToken`/`ActivityCategoryToken`/`WebDomainToken` values — see §4 for why this breaks the fixed-category model. |
| `SwiftData` | Local persistence, matching the spec's cross-platform schema (`sessions`, `settings`, `devices`, `active_session`). iOS 17+; see §9 for the iOS 16 fallback. |
| `URLSessionWebSocketTask` | Relay connection — same protocol as desktop/Android (`relay/src/server.ts`), no iOS-specific changes needed on the wire format. |
| `UNUserNotificationCenter` | Session-complete notification, matching the cross-platform notification content spec. |
| `CryptoKit` | `Curve25519.Signing` gives Ed25519 for free, natively, with none of the minSdk-style version anxiety Android has — this is a genuine advantage over the Android build. AES-GCM is also native via `CryptoKit.AES.GCM`. |

## 3. App structure

```
ios/
  FocusLock.xcodeproj
  FocusLock/                          — main app target
    FocusLockApp.swift                — @main, SwiftData ModelContainer setup
    Views/
      HomeView.swift                  — duration picker, category chips, Start; running = countdown ring
      LogView.swift                   — weekly viewer, bar chart (Swift Charts), CSV export via ShareLink
      DevicesView.swift               — pairing (host code + QR via CoreImage CIFilter.qrCodeGenerator, joiner code entry)
      SettingsView.swift              — category toggles, theme, relay URL, About
      OnboardingView.swift            — FamilyControls authorization request, category→token mapping first-run flow (§4)
    Session/
      SessionStore.swift              — the "SessionManager" equivalent: owns SwiftData context, relay client, starts DeviceActivityCenter monitoring
      SessionClock.swift              — monotonic clock via `ProcessInfo.processInfo.systemUptime` (survives wall-clock changes within one process lifetime — same caveat as desktop/Android, see DECISIONS.md pattern)
      GroupIdentity.swift             — device keypair (CryptoKit.Curve25519.Signing.PrivateKey) + group_id bootstrap, mirrors desktop bootstrapIdentity()
    Relay/
      RelayClient.swift               — URLSessionWebSocketTask wrapper; persistent per-message-type dispatch, NOT one-shot "next message" reads (see §8 — this is not optional, it's a lesson already paid for twice in this project)
      Protocol.swift                  — Codable structs mirroring shared/src/types.ts's SessionRecord / ClientToServerMessage / ServerToClientMessage
      Pairing.swift                   — SPAKE2 pairing client (see §6 — same gap as Android)
    Blocklist/
      Blocklist.swift                 — hand-ported mirror of shared/src/blocklist.ts, PLUS the category→token mapping table (§4)
    Notifications/
      NotificationManager.swift       — UNUserNotificationCenter, fired from SessionStore after ManagedSettingsStore is confirmed cleared (same unblock-then-notify sequencing as every other platform)
  FocusLockMonitor/                   — DeviceActivityMonitor extension target
    MonitorExtension.swift            — intervalDidStart/intervalDidEnd: read the scheduled shield config from the shared App Group container, apply/clear ManagedSettingsStore
  FocusLockShield/                    — (optional) ShieldConfigurationExtension target, for custom shield UI text/styling matching the mellow desktop aesthetic instead of the iOS default shield screen
  Shared/
    (App Group–shared code between the app and the extension targets — the extension can't talk to the main app's in-memory state, only shared UserDefaults(suiteName:)/SwiftData with an App Group container)
```

## 4. The category-token divergence (read this before implementing DevicesView/Blocklist)

Every other platform in this project uses a **fixed category model**: `social` / `games` / `video` / `news`, each with a hardcoded domain/process list in `shared/src/blocklist.ts` (or its Android mirror). This is explicitly required by spec ("Fixed built-in categories only. No custom entries — that removes the obvious loophole").

**Apple does not let a third-party app know what apps are installed, or block by bundle identifier.** `FamilyActivityPicker` returns opaque, per-device, per-authorization `ApplicationToken`s that have no stable meaning outside that one device's Screen Time authorization — Focus Lock cannot ship a pre-built list of "these tokens = Instagram" the way it ships a pre-built list of "these domains = Instagram" on every other platform.

Apple *does* expose `ActivityCategoryToken`s for its own built-in category taxonomy (Social, Games, Entertainment, etc.), which map reasonably well onto this project's four categories:

| Focus Lock category | Apple `ActivityCategoryToken` (approximate) |
|---|---|
| Social | `.social` |
| Games | `.games` |
| Video | `.entertainment` (closest fit — Apple doesn't have a "video" category distinct from general entertainment) |
| News | `.newsAndMagazines` (naming varies by iOS version; verify against the current `FamilyActivityPicker`'s exposed categories at implementation time) |

This covers most of the fixed-category model automatically — a user picks "Social" once, and Apple's own category membership (which Apple maintains, not Focus Lock) determines what's shielded. **Web domain blocking works identically to the other platforms** (`shield.webDomains` takes plain hostnames, matching `shared/src/blocklist.ts` directly — this part has full parity).

Where it breaks: some apps aren't cleanly categorized by Apple's taxonomy the way this project's hand-curated lists are (e.g., Discord spans "Social" ambiguously depending on Apple's own categorization, which Focus Lock doesn't control and can change between iOS versions). **The honest fix, and what `OnboardingView` should implement:** during first-run setup, in addition to the four category toggles, show the `FamilyActivityPicker` once and let the user manually add specific apps that Apple's categories don't cleanly cover. This is a real, documented divergence from the "fixed categories, no custom entries" model on every other platform — it exists because iOS makes the alternative (silently under-blocking apps Apple miscategorizes) worse, not because this design wanted to reopen the custom-entry loophole. State this plainly in the app's own UI copy, not just in code comments.

## 5. Session lifecycle (mirrors desktop/src/daemon/session-manager.ts)

1. **Start** (`SessionStore.startSession`): build the same `SessionRecord` shape as every other platform (group_id, session_id, started_at, ends_at, categories, label, origin_device, nonce), sign it with the shared group Ed25519 key (via `CryptoKit`), persist to SwiftData's `active_session` row, publish to the relay, and call `DeviceActivityCenter.shared.startMonitoring(_:during:)` with a `DeviceActivitySchedule` spanning `started_at...ends_at`. The 8-hour cap and duration validation are identical to every other platform — reuse the same validation logic pattern as `shared/src/deadman.ts`.
2. **Enforcement is not something the app does while running.** `MonitorExtension.intervalDidStart` (invoked by the OS, potentially with the app fully killed) is what actually sets `ManagedSettingsStore().shield.applicationCategories = ...` / `.shield.webDomains = ...`. This is the single biggest structural difference from every other platform: there is no "daemon process that could be killed" to defend, because the enforcing code isn't Focus Lock's process at all once scheduled.
3. **No pause/cancel**: same as every platform — `SessionStore` exposes no such method, and there is no OS-level "cancel this DeviceActivitySchedule" call wired to any UI element. (The user *can* still revoke Screen Time authorization or delete the app entirely — see §7. That is a materially different, and un-preventable, escape hatch from "no cancel button in this app.")
4. **Completion**: `MonitorExtension.intervalDidEnd` clears the `ManagedSettingsStore` shield properties — this is the actual unblock, and it happens whether or not the app is running, which is strictly better than every other platform's "the daemon must be alive to unblock" model. The main app, next time it's foregrounded (or via a silent push if implemented — not scoped here), reads the DeviceActivity extension's completion signal (via the shared App Group `UserDefaults`), writes the completed `sessions` row, and fires the `UNUserNotificationCenter` notification — sequenced after confirming the shield is clear, matching every other platform's unblock-then-notify rule.
5. **Dead-man's switch**: on every app launch and extension invocation, compare the persisted `active_session.ends_at` against `Date()`; if already past, ensure the shield is cleared (calling `ManagedSettingsStore().clearAllSettings()` is idempotent and safe to call even if nothing is currently shielded) before doing anything else. Same pattern as `shared/src/deadman.ts`'s `shouldEnforceOnStartup`.

## 6. Pairing: same SPAKE2 gap as Android, for the same reason

`shared/src/pairing.ts`'s SPAKE2 exchange has no Swift/CryptoKit equivalent shipped by Apple, and hand-porting elliptic-curve PAKE math into Swift without any way to test it in this environment carries the same risk profile documented for Android in `DECISIONS.md`. **Do not implement SPAKE2 from scratch for iOS either** — either port a reviewed implementation, or find and vet a maintained Swift package (none identified/verified here). Everything else in `Relay/Pairing.swift` (the challenge-code UI flow, the relay message routing) can be written now; only the actual `hostBeginPairing`/`joinerBeginPairing`/`*FinishPairing` cryptographic calls are blocked on this.

Once pairing crypto exists, the group private key arrives the same way as every other platform: encrypted with the PAKE-derived key, transported over the relay's blind-routing `pairing.group_key` message, decrypted locally, and persisted to `GroupIdentity`'s Keychain-backed storage (use `Keychain`, not `UserDefaults`, for the private key specifically — the one iOS-specific hardening this project should not skip, since Keychain is free and exactly what it's for).

## 7. Be honest about what this cannot guarantee (put this in the shipped app's own copy, not just here)

Every other platform in this project goes to real lengths to be un-killable and tamper-resistant: elevated daemons, watchdog processes, hosts-file/firewall state that survives a kill, Device Admin blocking uninstall on Android. **None of that is available on iOS, and pretending otherwise would be dishonest:**

- The user can open Settings → Screen Time → and turn off "App & Website Activity" / revoke Focus Lock's authorization at any time. There is no permission Focus Lock can hold that prevents this — Apple designed Screen Time controls to always be reachable by the device owner, specifically *because* the parental-controls use case requires the phone's actual owner (a parent) to always be able to override it. A self-imposed focus tool inherits that same override path.
- The user can delete the Focus Lock app entirely, at any time, the same as any app.
- **The one meaningful hardening available is a Screen Time passcode the user sets and then deliberately doesn't tell themselves** (e.g., has a partner set it, or uses a random string and doesn't save it) — this is an Apple OS feature (Settings → Screen Time → "Use Screen Time Passcode"), not something Focus Lock's code can set on the user's behalf (Focus Lock is not a parental-control app managing a child's device; it has no API to silently set a passcode the user then can't see). **This must be a manual step the user is walked through during onboarding, with the app's copy explicitly saying "we cannot force this — you have to choose not to know your own passcode, deliberately, right now, if you want this to actually resist you."** Overclaiming tamper-resistance here would be a worse failure than the desktop/Android gaps combined, because the entire value proposition of this category of app is "the version of me setting this up doesn't trust the version of me an hour from now" — silently failing at that trade, instead of stating the limit plainly, breaks the product's actual promise.

## 8. Relay client: reuse the lesson, don't relearn it

`RelayClient.swift`'s `URLSessionWebSocketTask` message loop **must** dispatch by message content/type via persistent handlers, not a one-shot "await the next message, treat it as my response" pattern. This exact bug was found and fixed twice already in this project — once in `relay/test/relay.test.ts` (the relay can legitimately send two messages back-to-back with no I/O gap, e.g. `pairing.group_key` immediately followed by `pairing.complete`), and again in `desktop/test/daemon-process.test.ts` (`SessionManager` broadcasts `session.state` from inside `startSession()` before its own IPC handler returns, so an RPC response can arrive after an unrelated broadcast on the same connection). `URLSessionWebSocketTask.receive(completionHandler:)` has the exact same shape of footgun — calling `receive` again only after processing what you got, keyed by message content, not "first thing back after I sent my request."

## 9. iOS version floor

**iOS 16+**, per spec. `DeviceActivity`/`ManagedSettings`/`FamilyControls` all shipped in iOS 15, so the floor is really about `SwiftData` (iOS 17+) — on iOS 16 specifically, fall back to `Core Data` or a lightweight `SQLite` wrapper with the identical schema; don't block the whole app's minimum version on SwiftData alone if 16.x share matters at ship time. This is a build-time decision to revisit against actual iOS version-adoption data when this is picked up for real implementation, not decided here.

## 10. What's needed before a single line of this gets written for real

See `SETUP-MOBILE.md` for the exact human steps (Apple Developer enrollment, the FamilyControls entitlement request and its multi-week review timeline, Xcode signing, a physical test device — Simulator does not support FamilyControls). None of §2–§9 above can be validated without all of those in place first.
