# Calorie Logger Agent Guide

## Product

Calorie Logger is a deliberately small, private calorie and macro logger. It tracks calories, protein, fat, and carbohydrates, with an emphasis on fast reuse of a personal food library. The responsive interface is an installable PWA for iPhone, iPad, and Android and is also bundled in a macOS menu-bar host.

The product name is **Calorie Logger**. Never introduce or restore a different product name in interface copy, metadata, documentation, diagnostics, code-facing labels, filenames, environment variables, stored keys, deployment assets, HTTP routes, or ordinary prose, and do not add aliases or backward-compatibility shims for an earlier name. This is a rule about naming the product, not about vocabulary: an ordinary English word that happens to appear in a former name is still an ordinary English word, and is fine wherever it reads naturally.

Current features include the day log, date navigation, targets, a usage-ranked personal food catalogue seeded from a shipped default catalogue of everyday foods, resetting the account back to that catalogue, tinting foods that take a large share of a fat or
carbohydrate target, custom, externally sourced, and one-off foods, portions described in words and estimated by a language model, mobile barcode scanning and food, label, or recipe photographs, quantity scaling, breakfast/lunch/dinner/snack sections, entry editing/deletion/reordering, copying entries, repeating a meal from the previous day, JSON export, shared private accounts, PWA installation, a native menu-bar summary, and full offline use with automatic synchronisation across devices. Self-registration and password recovery are deferred.

`README.md` is the public front page. `docs/setup.md` covers installing, updating, and operating a
server; `docs/sync.md` is the replication design; `docs/development.md` is the contributor guide.
Keep user-facing documentation free of implementation detail, and keep implementation detail out of
`README.md`.

Supported client platforms are Android and iOS/iPadOS through the installable PWA,
macOS through both the PWA and native menu-bar host, and Linux through the web/PWA.
Windows is intentionally unsupported and out of scope. Do not add Windows-specific
build targets, packaging, compatibility code, CI jobs, or documentation.

## Architecture

The application has three layers:

1. `web/` is the Vite, React, and TypeScript PWA. It owns the responsive UI, the complete local replica of the owner's data, every domain operation over it, and the synchronisation engine. `FoodRepository` resolves entirely against the replica; only external-catalogue search, barcode lookup, and described-portion estimates reach the network.
2. `pocketbase/` is the pinned server package. One canonical bootstrap migration defines the complete private owner-scoped schema; hooks implement authentication, the single versioned `/sync` merge route, external-food search, and the described-portion estimate. The server stores and merges records; it does not compute days, ordering, or exports. Generic collection access is blocked.
3. `macos/` is a thin Swift/AppKit host. It owns the native window, menu-bar item and popover, session storage, JSON export panel, the in-place updater and login item, and the reduced typed bridge.

The macOS app bundles `web/dist` and serves it to `WKWebView` through `WebInterfaceSchemeHandler` on the `calorie-logger://app` origin. Do not revert this to `loadHTMLString` with a `file://` base URL: a `file://` page has no usable IndexedDB, which is where the offline replica lives, and WebKit may parse `file://` script tags without executing them, resulting in a blank window. A hosted `WKWebView` test asserts both that the interface renders and that `indexedDB.open` succeeds.

Web bridge calls are limited to session persistence, export saving, and menu-summary updates.

## Source Map

- `web/src/App.tsx`: complete day view and modal workflows for foods, quantities, targets, copying, repeating, and export.
- `web/src/styles.css`: editorial visual system and desktop/tablet/phone responsive layouts.
- `web/src/FoodCamera.tsx`: the one camera surface — continuous barcode scanning, the offer it makes when it sees one, and the still it sends for estimation.
- `web/src/repository.ts`: the `FoodRepository` contract, implemented against the local replica.
- `web/src/data/foods.yaml`: the shipped default food catalogue.
- `web/src/data/pictures.yaml`: the approved food picture allowlist, with the labels and keywords the search model embeds.
- `web/src/defaultCatalog.ts`: the catalogue loader and the deterministic seed ids.
- `web/src/localStore.ts`: the in-memory dataset, every domain operation over it, and the replication queue.
- `web/src/localDatabase.ts`: the IndexedDB mirror, with an in-memory fallback for tests.
- `web/src/sync.ts`: the synchronisation engine and the status it reports.
- `web/src/api.ts`: HTTP client, session lifecycle, `/sync` transport, and external-food lookups.
- `web/src/SyncStatus.tsx`: the header status chip and the sync panel.
- `web/src/ids.ts`: client-generated record ids, device id, and canonical timestamps.
- `web/src/session.ts`: browser/native session-store abstraction and safe URL normalization.
- `web/src/pwa.ts`: service-worker registration, the installation prompt, platform detection, and the explicit update offer.
- `web/src/version.ts`: the build identity substituted by Vite, declared in `web/src/globals.d.ts`.
- `web/src/types.ts`: shared web domain types and nutrition calculations.
- `web/src/date.ts`: local calendar-date helpers.
- `macos/Sources/CalorieLoggerApp.swift`: application lifecycle, standard movable macOS window, `WKWebView`, menu commands, and window reopening.
- `macos/Sources/WebInterface.swift`: the custom-scheme handler that serves `web/dist` on a real origin, plus startup diagnostics.
- `pocketbase/pb_migrations/1724140800_calorie_logger_schema.js`: the complete canonical PocketBase schema bootstrap.
- `pocketbase/pb_hooks/calorie-logger.js`: authentication, the `/sync` merge, external-food search, the portion estimate, and the macOS release manifest.
- `pocketbase/pb_hooks/main.pb.js`: route registration, including the static macOS download route.
- `macos/Sources/Bridge.swift`: session bridge, menu-summary receiver, and native JSON save panel.
- `macos/Sources/Models.swift`: minimal native bridge and menu-summary models.
- `macos/Sources/MenuBarController.swift`: three-lane macro status icon, the update mark beside it, and the SwiftUI totals popover.
- `macos/Sources/AppRelease.swift`: the running build's identity and the published release it compares against.
- `macos/Sources/UpdateService.swift`: checking, downloading, verifying, replacing, and relaunching.
- `macos/Sources/PreferencesWindow.swift`: the native settings window and the `SMAppService` login item.
- `scripts/version.sh`: the single source of the version and build stamp every layer reports.
- `scripts/package-macos-release.sh`: the release build, its archive, and the manifest the updater reads.
- `deploy.sh`: the local, ordinary-sudo, and hardened-helper install paths.
- `scripts/generate_app_icons.py`: builds both launcher masters and every platform icon size from the approved artwork.
- `scripts/prepare_food_pictures.py`: builds the bundled food pictures and the server's approved-picture list from `icons/`.
- `scripts/integration/calorie_logger_api.py`: disposable local PocketBase integration suite.
- `scripts/integration/data_preservation.py`: proves a deployment keeps records, accounts, sessions, and the sync dataset identity across a new migration.
- `macos/Tests/DatabaseTests.swift`: bridge models, scheme-handler path and content-type checks, and hosted WebKit rendering and IndexedDB tests.
- `macos/project.yml`: XcodeGen source of truth, web build phases, and target settings.

`macos/CalorieLogger.xcodeproj` is generated. Change `macos/project.yml`, then regenerate; do not hand-edit the project file.

## Data Model and Persistence

Every device holds a complete replica of its owner's data in IndexedDB, and the interface reads and writes only that replica. PocketBase holds the shared copy that devices converge on. All records are scoped to an authenticated owner and generic record API rules are closed.

- `foods` stores the personal reusable food library. Nutrition is defined for a configurable basis amount in grams, millilitres, or countable items.
- A food marked `oneOff` is never offered in the food list. It is otherwise an ordinary food: entries reference it, edits reach every entry that uses it, copies share it, and it is tombstoned automatically once no entry references it any more.
- `log_entries` stores the local `YYYY-MM-DD` date, amount, order, and a required saved-food relation. Entry names, pictures, units, and nutrition are always derived from the current saved food, so food edits immediately update every referenced entry. Deleting an in-use food requires count-aware confirmation and deletes every referenced log entry with the food, on every device.
- `user_settings` contains one target record per owner.
- `sync_state` holds one server-owned merge sequence per owner. It is not replicated.

Record ids are generated by the client, so anything created offline can be edited, reordered, and
deleted before a server has ever seen it. Every replicated record carries `deleted`, `created_at`,
`edited_at`, `edited_by`, and `revision`:

- `edited_at` and `edited_by` are the writing device's clock and identity, and decide which version of a record survives a merge — later wins, and an equal timestamp is broken by device id so every replica reaches the same answer independently.
- `revision` is assigned by the server from the owner's sequence and is the cursor clients pull against. A wall clock cannot serve that purpose, because records written while a request is in flight would be skipped.
- Deletions are tombstones. Rows are never removed, so a device that has been offline still learns what was deleted.

Every sync reply carries a `datasetId`, the owner's `sync_state` record id, which identifies the
database the `revision` cursor counts in. A rebuilt database restarts that sequence at zero, so a
device holding a cursor from the previous database would ask for revisions
the new one has not reached, pull nothing, push nothing — its records were already confirmed, so
nothing is pending — and report itself perfectly in sync while showing data no other device can
see. When the id changes, the client sets its cursor back to zero and marks everything it holds
pending again, tombstones included. Never let a cursor outlive the database that issued it.

`SCHEMA_VERSION` covers the replicated record shape and is asserted on every sync. A client that
disagrees is refused a merge and told to update, while its local reads and writes continue.

Timestamps are ISO-8601 UTC strings. `edited_at` must be exactly what `Date.prototype.toISOString`
emits, including three-digit milliseconds, because merge order compares those strings directly.
Display dates and day navigation use the user's local calendar. Preserve unrounded values for
calculations; round only for display.

## Data Policy

Calorie Logger has been in real use since 2026-08-22. The owner's foods, log entries, and targets
are records, not test data: they must survive every deployment, every schema change, and every
app update. The PocketBase database is the record; each device's IndexedDB replica is a cache of
it.

Deployments do not rebuild the database. The deployment helper copies it to
`<install root>/backups/<timestamp>/` first, then starts the new release against the existing
data, and PocketBase applies whatever migrations are new. `./deploy.sh --reset-data` exists for a
deliberate clean start and asks for confirmation; nothing else deletes application data.

When a schema, API, stored key, or model changes:

- `pocketbase/pb_migrations/1724140800_calorie_logger_schema.js` is frozen. It bootstraps a fresh
  database and is never edited again -- a database that has already run it would never see the
  edit.
- Ship every later change as a new `<unix timestamp>_<name>.js` migration that transforms the
  existing database: add a field, backfill it, drop a field. One migration per change, applied in
  filename order, never rewritten once deployed.
- Deleting a field still means deleting it — from the collection, the hooks, the client, and the
  documentation — but through a migration that leaves every other field standing.
- Bump `SCHEMA_VERSION` in `web/src/localStore.ts` and the hook together when the replicated
  record shape changes. A device holding the older shape is refused a merge and told to update;
  its local reads and writes keep working until it does.
- A device whose `SCHEMA_VERSION` no longer matches rebuilds its replica from the server rather
  than converting it in place. That is the transition path, and it is only safe because the
  server keeps everything, which is why the rules above are not optional. Local changes that were
  never uploaded are the one thing it can lose, so never ship a schema change and a sync change
  that cannot be deployed together.
- Test fixtures and the integration suites use the current schema; their own data stays
  disposable, and they must never point at a server the owner uses.

## Development Workflow

Requirements: macOS 14+, Xcode, Node.js 20+, npm, and XcodeGen.

```sh
npm install --prefix web
npm run dev          # Vite development; connect to a Calorie Logger server in the UI
npm run build:web
npm run stage:pwa    # generates pocketbase/pb_public
npm run server:up    # local Docker full stack
npm run generate:pictures
npm run generate:mac
npm run build:mac    # builds build/Calorie Logger.app
npm run package:mac  # release build, archive, and updater manifest
npm run run:mac      # builds and launches the app
npm test             # web tests, web production build, and native tests
POCKETBASE_BIN=/path/to/pocketbase npm run test:server
```

The app carries an ad-hoc signature only. After replacing a build, fully quit the previous process before reopening it, because the menu-bar app remains alive after its main window closes.

There is one version identity, and `scripts/version.sh` is its only source: the semantic version comes from the root `package.json`, and the build stamp is a UTC minute regenerated per build. Every build step inherits both, so one build reports one identity in the web bundle, the macOS `Info.plist`, and `/health`. The macOS updater compares the build stamp rather than the version, because a release that forgets to bump the version must still reach the desktop -- the application and the server's record shape move together.

## Implementation Rules

- Keep the web UI independent of Swift/AppKit and put platform behavior behind `FoodRepository`.
- Keep macOS-specific behavior native; do not implement the status item or save panel in the web UI.
- Never access PocketBase collection routes or its JavaScript SDK from web UI code; keep all providers behind `FoodRepository` and the Calorie Logger API contract.
- Every user-visible operation must work with no server reachable. Only external-catalogue search, barcode lookup, and described-portion estimates may require the network, and their absence must never block logging.
- Opening the app must complete without any network work. Restoring the session, loading the replica, and painting the day are local; token refresh and the first sync happen afterwards. A device in airplane mode with a VPN interface configured does not fail requests, it leaves them outstanding, so anything awaited before the first paint can hang the app indefinitely.
- Give every request a timeout, and never let one leave the interface in a pending state for ever.
- Startup must always reach either the day or the sign-in screen. A step that fails must be caught and resolved to one of them, never left on the loading screen.
- Validate every sync input server-side and explicitly scope every query and write to the authenticated owner. A record that fails validation is rejected individually and reported back; it must never fail the whole batch, because that would wedge a device's queue permanently.
- Do not add unique constraints to replicated collections. A uniqueness rule that two offline devices can both satisfy produces a push that can never merge.
- Do not store a field that changes as a side effect of unrelated activity, such as a usage counter. Under last-writer-wins it would overwrite genuine edits made on another device; derive it instead.
- Never commit or prefill a server URL, email, password, token, superuser detail, or provider API key. This includes test fixtures: an address that happens to be a real server is a leak, so use documentation-style hosts. Passwords are never persisted. The estimator's key is read from the server environment, kept in a server-held `secrets.env` outside every release, and never echoed back in a response.
- The food estimator is provider-neutral: Gemini's API and the OpenAI chat-completions shape, chosen by `AI_PROVIDER`. Never name one provider in interface copy or in a message the owner sees -- report whichever is configured, or that none is.
- Preserve required owner-scoped food relations and stable ordering during all food-library and copy operations. Do not duplicate saved-food nutrition or presentation fields into log entries.
- Follow the Data Policy: the owner's records survive every change. Replace superseded designs directly in the code, but move the data across with a new migration rather than resetting it, and never edit the frozen baseline migration.
- Bundled and user-selectable food artwork is restricted to the approved vegan picture allowlist in `web/src/data/pictures.yaml`. Do not introduce any additional non-vegan graphics. Transient external-catalogue photos may appear only in search results and must never be saved in foods, entries, or exports.
- Food pictures are bitmap artwork stored as `pic:<id>` values. The masters live in the untracked `icons/` directory; `npm run generate:pictures` writes the bundled WebP set and the server's approved-picture list, and refuses to run while the catalogue and the masters disagree. Never edit a bundled picture or the generated allowlist by hand, and add attribution for new third-party artwork to `web/src/data/picture-credits.yaml` and `THIRD_PARTY_NOTICES.md`.
- The default food catalogue is `web/src/data/foods.yaml`, hand-edited plain data. It is seeded when a device's first successful sync finds the account empty, and restored by Settings → Reset app data. Seeded foods take deterministic ids derived from their names, so two devices that both meet an empty account produce one catalogue rather than two; never give them random ids.
- A reset is an ordinary local write: tombstone everything, write the catalogue back, let replication carry it. Do not add a server route for it, and do not let it bypass the pending queue.
- Keep the interface calm, minimal, keyboard accessible, and responsive down to phone width.
- Every full-height surface owns exactly one scroller, and nothing scrolls inside it. On a phone the Add food browser is that surface for the picker, and the food editor's own body is that surface for the editor; neither may contain a second scrolling element. A panel positioned against an ancestor outside its scroll container contributes no height to it, so its content below the fold becomes unreachable even though the panel renders — that is how the editor's macros and save button were lost. The browser smoke test scrolls to the last catalogue food and to the end of the editor to prove both.
- A layer is mounted or it is absent. Never hide one with the `hidden` attribute: any author `display` rule beats the browser's own `[hidden] { display: none }`, and a blank food editor survived on every other tab for exactly that reason.
- The app must never reload itself by gesture. `overscroll-behavior-y` is off on `html, body`, because Chrome's pull-to-refresh discarded an open dialog and everything typed into it.
- Say what could not be reached and why. A private or Tailscale address that times out is a disconnected tunnel far more often than a broken internet connection, and "check your connection" sends the owner looking in the wrong place.
- Add regression coverage for every corrected user-visible bug. For embedded UI failures, prefer the hosted `WKWebView` rendering test over tests that only inspect generated strings.
- The macOS session, API token included, is stored in preferences and never in Keychain. The app is
  ad-hoc signed, so its code identity changes on every build, and macOS ties a Keychain item to the
  identity that wrote it: each new build was asked to unlock the login keychain for an item it had
  written itself. Training the owner to answer that prompt is worse than where the token sits.
- The application never updates itself without being asked. The service worker must not call `skipWaiting()` or `clientsClaim()` of its own accord: a new worker that activates mid-use reloads the page underneath whoever is typing. It downloads in the background, says it is doing so, and applies the update on a button. The macOS host works the same way, and marks the menu bar rather than interrupting.
- The macOS application is published by the deployment, from the server the app already syncs with, and it verifies the archive against the manifest checksum before replacing itself. Fetch it with `URLSession` and never through a browser or `NSWorkspace`, or the download acquires the quarantine attribute and every update asks the owner to trust the app again. A deployment made where the application cannot be built leaves the previously published one in place rather than withdrawing the download.
- Precache the complete built shell, including every bundled asset type, so the app opens with no connection. Cache only those files in the service worker. Never cache API responses, nutrition data, or external-provider responses there. The owner's own records live in the IndexedDB replica, which is not an HTTP cache.
- Keep launcher artwork on an opaque square canvas with platform-safe padding; Android, iOS/iPadOS, and macOS apply their own icon masks, so do not bake rounded or transparent corners into icon assets. Size that padding per platform rather than once for all of them: Android's masks cut deeply and need a wide disposable field, while Apple's trim almost nothing and return the same field as a heavy frame. Regenerate every size with `npm run generate:icons` instead of editing an icon file by hand.
- Do not commit changes unless the user explicitly asks for a commit.
- After making changes, report verification results and provide a moderately detailed proposed Git commit message for the user to use. Show the message only; do not run `git commit`.
