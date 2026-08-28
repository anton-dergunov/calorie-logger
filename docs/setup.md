# Setup

Calorie Logger is self-hosted. You run one small server; every device keeps a complete copy of your
log and syncs through it. This page covers installing that server, getting the apps onto your
devices, and keeping both up to date.

There is nothing to sign up for and no account anywhere but your own server.

## What you need

- **A server.** Anything that runs Docker and stays on: a NAS, a Raspberry Pi 4 or newer, a small
  rented Linux box, or the laptop you are reading this on. About 200 MB of disk plus your log.
- **A computer with Node.js 20+ and Docker** to build and deploy from. It can be the same machine.
- Optionally, an API key for a vision-capable language model, if you want to describe or photograph
  a portion and have it estimated. Everything else works without one.

```sh
git clone https://github.com/anton-dergunov/calorie-logger.git
cd calorie-logger
```

## Install

### On this computer

The simplest possible install. No SSH, no remote server, nothing to configure:

```sh
./deploy.sh --local
```

It builds the app, starts PocketBase in Docker, waits until it answers, and prints the address —
`http://127.0.0.1:8090` by default. Your data lives in `~/.calorie-logger`.

By default the server listens only on this computer. To let your phone reach it over the same
network:

```sh
CALORIE_LOGGER_BIND=0.0.0.0 ./deploy.sh --local
```

Then open `http://<this computer's address>:8090` on the phone. Note that browsers only allow an
app to be **installed** over HTTPS or on `localhost`, so over plain HTTP on a phone you get a
working web page but not an installed app. See [HTTPS](#https) for the fix.

Running the server on a laptop works better than it sounds: every device holds the whole log and
queues its changes, so the phone keeps working while the laptop is shut, and everything merges the
next time they are on the same network.

### On a server over SSH

```sh
./deploy.sh
```

The first run asks once for an SSH destination like `pi@raspberrypi.local` or
`you@server.example.com` and remembers it. Every later update is the same one command.

The server needs SSH access and Docker; it does **not** need Node.js, npm, Git, or a checkout of
this repository. On ordinary Linux the deployment installs Docker if it is missing. `sudo` will ask
for your password once per deployment — see [deploying without a password
prompt](#deploying-without-a-password-prompt) if that gets tiring.

Run `./deploy.sh --configure` to point at a different server.

Where it installs:

| Server | Install root |
|---|---|
| Synology DSM | `/volume1/docker/calorie-logger` |
| Everything else | `/opt/calorie-logger` |

To use a different path, write it into `/etc/calorie-logger-root` on the server, as root, once. It
must be an absolute path ending in `/calorie-logger`.

#### Synology

Install **Container Manager** from Package Center first; DSM has no supported way for a script to
install Docker itself. Enable SSH in Control Panel → Terminal & SNMP. Everything else is the same.

#### Raspberry Pi

Nothing special — a 64-bit Raspberry Pi OS on a Pi 4 or newer runs it comfortably. The image is
built for arm64 automatically.

## Create your account

Registration is deliberately closed: this is your server, and accounts are made by you. After the
first deployment, create the administrator, then add yourself as an ordinary user:

```sh
docker exec -it calorie-logger-pocketbase \
  /pb/pocketbase superuser upsert 'you@example.com' 'A_STRONG_UNIQUE_PASSWORD'
```

If your shell account isn't in the `docker` group, prefix that command with `sudo`.

Then open `/_/` in a browser, sign in with those details, open the `users` collection, and create
your own account there. That second account is the one you sign into Calorie Logger with — never
the administrator one.

Sign in at the server's address — the same one `./deploy.sh` printed, such as
`http://127.0.0.1:8090`. The web app takes the server from the page it is served from, so it only
asks for an email and a password.

## Install the apps

### iPhone and iPad

Open the server's address in **Safari**, tap **Share**, then **Add to Home Screen**. The app opens
the installation steps for you the first time.

### Android

Open the address in **Chrome** and use the **Install** button the app offers, or Chrome's ⋮ menu →
**Install app**.

### macOS

The browser works fine, but there is also a native application that keeps today's protein, fat, and
carbohydrate progress in the menu bar. When you open Calorie Logger in a browser on a Mac, it
offers the download; you can also find it under **Settings → About**.

Drag it to **Applications** and open it. The first launch shows macOS's "downloaded from the
internet" warning — open **System Settings → Privacy & Security** and choose **Open Anyway**. That
happens once. From then on the app updates itself in place and never asks again.

The Mac app is built and published **by the deployment**, on macOS. Deploying from Linux skips the
step and leaves whatever the server already offers in place, so the download never disappears.

### Linux and desktop browsers

Open the address. Chrome and Edge will offer to install it as an app; any browser works as a page.

## Updates

Deploy again:

```sh
./deploy.sh
```

That builds the current checkout, backs up the database, applies any new migrations, and restarts.
Then:

- **Web and PWA:** the app notices the new version, downloads it in the background, and offers it.
  It never reloads underneath you — the gear gets a dot, and **Settings → Update Calorie Logger**
  applies it.
- **macOS:** the app checks your server on launch and every few hours. When there is something
  newer, a dot appears next to the menu bar meters and the popover offers **Update to …**. One
  click replaces the app and reopens it.

Keeping up to date matters more here than in most apps: a release can change the shape of the
records that sync, and a device running an older shape is refused a merge until it updates. It
keeps working locally in the meantime and tells you why.

### If the Mac app is too far behind to update itself

A copy that has gone a long time without an update can be old enough that its own updater is one of
the things fixed since — the download starts and then crawls, or never finishes at all. Replace it
by hand, once:

1. Click the menu bar meters and choose **Quit Calorie Logger**. Closing the window is not enough;
   the app stays in the menu bar.
2. Open Calorie Logger in a browser on that Mac and download the app from **Settings → About**.
3. Drag it to **Applications**, replacing the copy already there, and open it. Because this one came
   through a browser, macOS asks once more whether to trust it: **System Settings → Privacy &
   Security → Open Anyway**.

**Settings → Updates** then shows the version you just installed, and updating in place works again
from there.

## Your data

**Deployments keep your data.** The database is copied to `<install root>/backups/<timestamp>/`
first, then the new release starts against the existing one and PocketBase applies whatever
migrations are new. Accounts, sessions, foods, log entries, and targets all survive. The ten most
recent backups are kept.

```sh
./deploy.sh --reset-data
```

is the one thing that deletes anything. It backs up first, then empties everything — accounts
included — and asks you to type `DELETE` before it does.

To take a copy yourself, use **Settings → Export data** in the app for a JSON file, or copy
`<install root>/pb_data/data.db` off the server while the container is stopped.

## HTTPS

Outside `localhost`, browsers require HTTPS before an app can be installed. Two options, both fine:

**A reverse proxy.** Point Caddy, nginx, or Traefik at `http://127.0.0.1:8090`, which is where the
deployment listens. Nothing else is needed; PocketBase serves both the API and the app from that
one origin.

**Tailscale.** Optional, and worth understanding rather than copying blindly. Tailscale is a
private network between your own devices. It is useful when your server has no public address and
you still want to reach it from a phone on mobile data — a NAS behind a home router is the usual
case. It is **not required**: if your devices only ever use the app at home, a plain address on your
own network is enough; and if the server has a real domain name and certificate, a reverse proxy is
simpler.

If you do use it, `tailscale serve` gives the server an HTTPS address on your tailnet without
opening anything to the internet:

```sh
tailscale serve status
tailscale serve --bg --https=8091 http://127.0.0.1:8090
```

Check the existing listeners before changing them, and have each device join the same tailnet.

Deployments never touch Tailscale, DNS, TLS, firewall, or reverse-proxy configuration.

## The food estimator (optional)

Describing a portion in words, or photographing a plate or a nutrition label, is answered by a
vision-capable language model. Without a key everything else works and the app simply says this
server has no estimator configured.

The key never goes in the repository or in a release. It lives in `secrets.env` in the install root,
which the deployment reads but never replaces:

```sh
umask 077
root=/opt/calorie-logger
[ -d /volume1/docker ] && root=/volume1/docker/calorie-logger
[ -f /etc/calorie-logger-root ] && root=$(cat /etc/calorie-logger-root)
cat > "$root/secrets.env" <<'EOF'
AI_PROVIDER=gemini
AI_API_KEY=your-key
AI_MODEL=gemini-3.1-flash-lite
EOF
```

For `--local`, the same file goes in `~/.calorie-logger/secrets.env`.

Two provider shapes are supported, which between them cover most of what exists:

| Setting | Meaning |
|---|---|
| `AI_PROVIDER` | `gemini` (default) or `openai` |
| `AI_API_KEY` | the key. Required; nothing else turns the estimator on |
| `AI_MODEL` | the model name. Required for `openai`; defaults to a Gemini model otherwise |
| `AI_BASE_URL` | for `openai`, the endpoint root. Defaults to `https://api.openai.com/v1` |

`openai` means the OpenAI chat-completions shape, not OpenAI specifically — OpenRouter, Groq,
together.ai, and a local Ollama or llama.cpp all speak it. For a local model:

```sh
AI_PROVIDER=openai
AI_BASE_URL=http://host.docker.internal:11434/v1
AI_MODEL=qwen3-vl
AI_API_KEY=ollama
```

Whatever you pick has to be able to read images if you want the photo features.

Deploy again for the change to take effect. The deployment says which secrets file it loaded, or
that it found none, and `/health` then names the provider and model instead of `null`.

## Deploying without a password prompt

Optional hardening, worth doing if you are changing the code and deploying often. It replaces the
per-deployment `sudo` password with a single reviewed command that root allows without one — and
notably does **not** grant unrestricted `sudo` or Docker access.

Copy the reviewed helper to the server, streamed over SSH so it does not depend on SFTP:

```sh
ssh user@server.example.com 'umask 077 && cat > /tmp/deploy-calorie-logger' \
  < scripts/deploy-pocketbase-remote.sh
ssh -t user@server.example.com
```

From that session, install it as root. `SUDO_USER` supplies the account that opened the root shell,
and the `id` check stops a sudoers rule being written for the wrong one:

```sh
sudo -i
deployment_user=${SUDO_USER:?Open this root shell with sudo -i from the deployment account}
id "$deployment_user" >/dev/null || { echo "Unknown deployment account: $deployment_user" >&2; exit 1; }
mkdir -p /usr/local/sbin /etc/sudoers.d
install -o root -g root -m 755 /tmp/deploy-calorie-logger /usr/local/sbin/deploy-calorie-logger
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/deploy-calorie-logger\n' "$deployment_user" \
  > /etc/sudoers.d/deploy-calorie-logger
chown root:root /etc/sudoers.d/deploy-calorie-logger
chmod 440 /etc/sudoers.d/deploy-calorie-logger
if command -v visudo >/dev/null 2>&1; then visudo -c; fi
rm -f /tmp/deploy-calorie-logger
exit
```

Check that exactly that command is allowed and nothing broader is:

```sh
ssh user@server.example.com 'sudo -n /usr/local/sbin/deploy-calorie-logger </dev/null'  # reaches the helper
ssh user@server.example.com 'sudo -n docker ps'                                         # must still ask for a password
```

`deploy.sh` verifies that the installed helper matches this repository's copy before it uploads
anything, and refuses to deploy through one that does not. When the helper changes, repeat the two
commands above once. Do not skip that: a superseded helper can run a current release the wrong way,
and the failure shows up later for reasons that do not point at the cause.

Remove `/usr/local/sbin/deploy-calorie-logger` and `/etc/sudoers.d/deploy-calorie-logger` to go back
to the ordinary password prompt.

## Checking a server

```sh
curl http://127.0.0.1:8090/api/calorie-logger/v5/health
```

The reply names the running version, the API and schema versions, the number of generic foods and
food pictures loaded, the estimator provider, and the published Mac release. PocketBase's own
`/api/health` is not enough: a generic PocketBase container answers it without having any of
Calorie Logger's schema or routes.

If `/api/health` works but `/api/calorie-logger/v5/health` returns 404, the running container was
not built from this repository. Deploy again.

## Troubleshooting

**"Only works on that local network" / a timeout on a private address.** The address is a private
or tailnet one that this device cannot currently reach. That is almost always a disconnected tunnel
or the wrong network, not a broken internet connection.

**The app shows an old version after deploying.** Open it and take the offered update. Until it is
applied, the installed service worker keeps serving the version it has, which is what lets the app
open with no connection at all.

**The PocketBase dashboard at `/_/` shows the app instead.** An old service worker from before the
dashboard was excluded is still installed. Open the app once so the new one takes over.

**Nothing to install on a phone over plain HTTP.** Browsers only allow installation over HTTPS or
on localhost. See [HTTPS](#https).
