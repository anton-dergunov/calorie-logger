# Calorie Logger

A small, private calorie and macro logger you host yourself. No accounts, no subscription, no ads,
no data leaving your own server.

It tracks calories, protein, fat, and carbohydrates, and it is built around one idea: logging what
you ate should take as few taps as possible, and what you learn from it should be visible without
having to go looking.

<!-- Screenshots: see docs/screenshots/README.md for what each one should show. -->
![The day log](docs/screenshots/day-log.png)

## See where your macros actually went

The day is a table, not a total. Every food is a row with its amount, protein, fat, carbohydrate,
and energy; every meal carries its own subtotals; the day's four numbers sit above it against your
targets.

So the question is not "did I get enough protein today" but "which food spent my carbohydrate
budget" — and the answer is on screen, next to the food that did it. It is the difference between a
number to feel bad about and something you can act on tomorrow.

Every food has a picture, so the day reads at a glance rather than as a wall of text.

![Adding a food](docs/screenshots/add-food.png)

## Log it in as few taps as possible

Your own catalogue comes first, ranked by what you actually eat, and it arrives with a starter set
of everyday foods already in it — you can log your first day without typing a single nutrition
figure. When your food is not there yet:

- **Scan a barcode.** Point the camera at a packet.
- **Photograph it.** A plate, a nutrition label, or a recipe. It reads the label properly, including
  which column it used.
- **Describe it.** "Large bowl of porridge with a spoon of peanut butter" gets estimated, with a
  confidence and a note when it is a wide guess.
- **Search food databases.** Open Food Facts for products, and the UK CoFID dataset for generic
  foods, listed separately so a busy product search cannot bury "potato".
- **Type it in.** Per 100 g, per millilitre, or per item, whatever the food is naturally measured in.

Then: **repeat yesterday's breakfast** in one tap when it was the same. Copy entries to another day.
Edit, reorder, or delete anything. Add something as a **one-off** so it gets logged without
cluttering your catalogue — it disappears on its own once nothing uses it.

Editing a saved food updates every day it has ever appeared on, because entries reference your
catalogue instead of copying it.

## Works offline. Syncs by itself.

Every device keeps a **complete copy** of your log and reads and writes it directly. There is no
spinner and no "could not connect": the app works identically on a plane, in a basement, and with
the server switched off.

When a device can reach the server again, it uploads what changed and picks up what other devices
did. Use your phone in the kitchen and your Mac at your desk and they simply agree. Deletions
travel too, so nothing you removed comes back.

Curious how? [docs/sync.md](docs/sync.md) explains the design and, more usefully, why each part of
it is that way.

## Runs where you do

| | |
|---|---|
| **iPhone / iPad** | Installable app via Safari |
| **Android** | Installable app via Chrome |
| **macOS** | Native app with today's macros in the menu bar, plus the browser |
| **Linux / Windows browsers** | The web app |

<img src="docs/screenshots/menu-bar.png" alt="The macOS menu bar summary" width="420">

The Mac app puts three small meters in the menu bar — protein, fat, carbohydrate against your
targets — so you can see what you are short of without opening anything. It updates itself from
your server in one click.

## Yours, and portable

- **Self-hosted.** One small container, one SQLite file. Runs on a NAS, a Raspberry Pi, a rented
  Linux box, or the laptop you already have.
- **No third-party account.** Registration is closed by design; you create the accounts.
- **Export whenever.** A complete JSON file of everything, all of it or a date range.
- **Nothing tracked.** No analytics, no telemetry, no ads. Food databases are searched only when you
  search them, and photos are only sent if you ask for an estimate.

## Install

```sh
git clone https://github.com/anton-dergunov/calorie-logger.git
cd calorie-logger
./deploy.sh --local      # run it on this computer
./deploy.sh              # or deploy it to a server over SSH
```

Then create your account and install the app on your devices. Full instructions, including
Synology, Raspberry Pi, HTTPS, when Tailscale is and is not needed, backups, and the optional AI
estimator: **[docs/setup.md](docs/setup.md)**.

Updating is the same command. The apps notice and offer the new version rather than reloading
underneath you.

## Documentation

- [Setup](docs/setup.md) — install, update, HTTPS, accounts, backups, troubleshooting
- [How synchronisation works](docs/sync.md) — the offline replica and merge design
- [Development](docs/development.md) — architecture, commands, tests, schema changes

## Credits and licence

MIT — see [LICENSE](LICENSE).

Food data comes from [Open Food Facts](https://world.openfoodfacts.org) and the UK Composition of
Foods Integrated Dataset. Barcode reading uses ZXing. The food pictures are by their respective
artists. Full attribution: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Portion estimates need an API key you supply, for Gemini or any OpenAI-compatible endpoint,
including a model running on your own machine. Everything else works without one.
