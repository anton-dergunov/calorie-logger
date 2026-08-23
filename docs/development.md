# Development

## Layout

Three layers, deliberately separated:

| Directory | What it owns |
|---|---|
| `web/` | The Vite + React + TypeScript app: the whole interface, the complete local replica of your data, every operation over it, and the sync engine. |
| `pocketbase/` | The pinned server: one canonical schema bootstrap plus later migrations, and hooks implementing authentication, the `/sync` merge, external food search, and the portion estimate. It stores and merges records; it does not compute days, ordering, or exports. |
| `macos/` | A thin Swift/AppKit host: the window, the menu bar item and popover, Keychain session storage, the export save panel, the updater, and a small typed bridge. |

The macOS app bundles `web/dist` and serves it to `WKWebView` over the `calorie-logger://app`
origin. It must not go back to `loadHTMLString` with a `file://` base URL: a `file://` page has no
usable IndexedDB, which is where the replica lives, and WebKit may parse `file://` script tags
without executing them, giving a blank window. A hosted `WKWebView` test asserts both that the
interface renders and that `indexedDB.open` succeeds.

See [sync.md](sync.md) for the replication design, and `AGENTS.md` for the full source map and the
rules that changes have to respect.

## Requirements

Node.js 20+, npm, Docker. For the macOS host also macOS 14+, Xcode, and
[XcodeGen](https://github.com/yonaskolb/XcodeGen).

```sh
npm install --prefix web
```

## Commands

```sh
npm run dev              # Vite dev server; connect it to a Calorie Logger server in the UI
npm run build:web
npm run stage:pwa        # builds web/dist and copies it into pocketbase/pb_public
npm run server:up        # local Docker stack
npm run server:down

npm run generate:mac     # regenerate the Xcode project from macos/project.yml
npm run build:mac        # build/Calorie Logger.app (Debug)
npm run build:mac -- --release
npm run run:mac          # build and launch
npm run package:mac      # release build, zipped, with the manifest the updater reads

npm run generate:icons   # every platform icon size from the approved artwork
npm run generate:pictures
```

`macos/CalorieLogger.xcodeproj` is generated. Change `macos/project.yml` and regenerate; never
hand-edit the project file.

The app is unsigned beyond an ad-hoc signature. After replacing a build, fully quit the previous
process before reopening it — the menu bar app stays alive after its window closes.

## Tests

```sh
npm test                                                   # web unit, production build, PWA checks, native tests
POCKETBASE_BIN=/path/to/pocketbase npm run test:server     # disposable local PocketBase
POCKETBASE_BIN=/path/to/pocketbase npm run test:browser    # the same, driving a real browser
```

`npm test` runs, in order: the CoFID preparation tests, the web unit tests, a production web build,
the PWA output checks, and the macOS build and tests.

The server and browser suites create disposable storage and runtime-generated accounts, and never
contact a configured server of yours. The browser suite uses the locally installed Google Chrome;
set `CALORIE_LOGGER_CHROME_PATH` to pick another Chromium.

`npm run test:pwa` verifies the generated manifest, icons, service worker, navigation fallback, that
no API response is cached, and that the worker does not activate itself without being asked.

## Versions

There are four version numbers, and they mean different things:

| Name | Where | Meaning |
|---|---|---|
| App version | `version` in the root `package.json` | What people see. Bump by hand. |
| Build stamp | `scripts/version.sh`, a UTC minute stamp | Regenerated per build. What the macOS updater compares. |
| `API_VERSION` | `web/src/api.ts` and the hook | The HTTP contract. In the URL. |
| `SCHEMA_VERSION` | `web/src/localStore.ts` and the hook | The shape of replicated records. Asserted on every sync. |

`scripts/version.sh` is the single source: `eval "$(scripts/version.sh)"` exports both values, and
every build step inherits them so one build reports one identity everywhere.

Bump `SCHEMA_VERSION` in the client and the hook **together** whenever the replicated record shape
changes. A device holding the older shape is then refused a merge and told to update, while its
local reads and writes keep working.

## Changing the schema

Calorie Logger holds real records. They survive every deployment, every schema change, and every
update. The PocketBase database is the record; each device's IndexedDB replica is a cache of it.

- `pocketbase/pb_migrations/1724140800_calorie_logger_schema.js` is **frozen**. It bootstraps a
  fresh database and is never edited again — a database that has already run it would never see the
  edit.
- Ship every later change as a new `<unix timestamp>_<name>.js` migration that transforms the
  existing database: add a field, backfill it, drop a field. One migration per change, applied in
  filename order, never rewritten once deployed.
- Deleting a field still means deleting it — from the collection, the hooks, the client, and the
  documentation — but through a migration that leaves everything else standing.
- Never ship a schema change and a sync change that cannot be deployed together. A device rebuilds
  its replica from the server across a version change, and local changes it never uploaded are the
  one thing that rebuild can lose.
- Do not add unique constraints to replicated collections, and do not store a field that changes as
  a side effect of unrelated activity. [sync.md](sync.md) explains why both break.

Test fixtures use the current schema, their data stays disposable, and they must never point at a
server anyone uses.

## Releasing

There is no separate release step. `./deploy.sh` builds the current checkout, and on macOS also
builds, signs, zips, and publishes the desktop application alongside the server. Deploying from
Linux skips that and leaves the previously published one in place.

To cut a new version, edit `version` in the root `package.json` and deploy.

## Food data

- `web/src/data/foods.yaml` is the shipped default catalogue: hand-edited plain data, seeded on a
  device's first successful sync against an empty account, and restored by Settings → Reset app
  data. Seeded foods take deterministic ids derived from their names, so two devices that both meet
  an empty account converge on one catalogue.
- `web/src/data/pictures.yaml` is the approved picture allowlist. Bundled and user-selectable food
  artwork is restricted to it, and it is all vegan. Masters live in the untracked `icons/`
  directory; `npm run generate:pictures` writes the bundled WebP set and the server's allowlist and
  refuses to run while the two disagree. Never edit a generated picture or the allowlist by hand,
  and add attribution for new third-party artwork to `attributions.txt` and
  `THIRD_PARTY_NOTICES.md`.
- The server-side generic food catalogue is rebuilt with
  `python3 scripts/prepare_cofid.py path/to/cofid.xlsx pocketbase/pb_hooks/data/cofid-2021.json`.
