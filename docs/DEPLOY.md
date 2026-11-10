# Deploying Book Club on one host

The original brief's stretch item 5: "a single-host Docker deployment with TLS, backups and a
restore drill, all documented and tested locally." Decision D51. The kit is [deploy/](../deploy/):

| File | What |
|------|------|
| `deploy/compose.yaml` | the app (the `runtime` image, no demo data, reachable only through the proxy), Caddy (HTTPS on ports 80 and 443, certificates from Let's Encrypt, renewed by Caddy), and a backup service |
| `deploy/Caddyfile` | the site: TLS, HSTS, a reverse proxy to the app (WebSockets and long uploads pass through) |
| `deploy/.env.example` | every setting: the address, the TLS e-mail, where backups go and how many to keep, and each optional feature |
| `deploy/compose.host-proxy.yaml` | with `compose.yaml`, for a host whose own web server already holds ports 80 and 443: no Caddy, the app on the host's loopback |
| `deploy/nginx/books.example.org.conf` | that site in nginx: certbot's certificate, HSTS, the WebSocket and uploads passed through, media unbuffered |
| `deploy/livekit/livekit.yaml.template`, `deploy/livekit/generate-config.sh` | voice channels and listening together (D153-D159): the self-hosted LiveKit server's config, generated from `deploy/.env`, never edited by hand |
| `deploy/nginx/rtc.books.example.org.conf` | LiveKit's signalling connection in nginx, on its own subdomain (DNS-only behind a CDN: see "Voice and listening together" below) |
| `deploy/offsite/` | an optional second copy of the backups in S3 (or any S3-compatible store), on a systemd timer |
| `deploy/gpu/bookclub-transcriber.service` | an optional GPU recogniser on another machine (docs/GPU-TRANSCRIPTION.md) |
| `deploy/auto-deploy.sh` | the forced command behind automatic deploys from CI ("Checks and automatic deploys" below) |
| `scripts/deploy-drill.sh` | the whole thing rehearsed on this machine, ending with a restore |

## Going live

1. A small Linux host with Docker, a DNS name pointing at it (A/AAAA record), ports 80 and 443 open.
2. On the host, in a clone of this repository:

   ```sh
   cp deploy/.env.example deploy/.env          # set BOOKCLUB_HOST and BOOKCLUB_TLS (your e-mail)
   docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build --wait
   (umask 077 && openssl rand -base64 18 > ~/.bookclub-owner)   # or a password of your own, 10 characters or more
   docker compose -f deploy/compose.yaml --env-file deploy/.env exec -T app \
     bookclub create-owner --email you@example.org --name You --club 'Our club' --password-stdin < ~/.bookclub-owner
   ```

   The password goes in on stdin, never on the command line: every user of the host can read a
   command's arguments, and the shell keeps them in its history.

3. Open `https://BOOKCLUB_HOST`, sign in, and share the club's invite link.

The app trusts only proxies on its own Docker network (`TRUST_PROXY=uniquelocal`, SA19); its
session cookie is Secure because the public address is https; HSTS is on. On a host where other
people have accounts, also set `BOOKCLUB_TRUST_PROXY_KEY` (`openssl rand -base64 32`): they can
reach the app's container from the same private address as Caddy, and name any client in
`X-Forwarded-For`; with the key, which Caddy sends, only Caddy can.

## Behind the host's own web server

On a host whose nginx (or other web server) already serves other sites on ports 80 and 443, Caddy
cannot have them. There `deploy/compose.host-proxy.yaml` leaves Caddy out and publishes the app on
the host's loopback, `127.0.0.1:3110` (`BOOKCLUB_APP_PORT`, below the kernel's ephemeral range: a
client connection can hold a port in that range just as the app starts), and
`deploy/nginx/books.example.org.conf` is the site in nginx. The rest is as above, with both compose
files (and `BOOKCLUB_TLS` still set, since `compose.yaml` requires it, though nothing reads it):

```sh
cd /opt/book-club               # the clone; deploy/.env is mode 600
bc() { docker compose -f deploy/compose.yaml -f deploy/compose.host-proxy.yaml --env-file deploy/.env "$@"; }
git pull --ff-only && bc up -d --build --wait     # an update by hand
bc logs -f app
```

- **The proxy key.** Other users of the host reach `127.0.0.1:3110` from the same address as nginx
  (Docker relays both from its gateway), so the app believes `X-Forwarded-*` only with
  `BOOKCLUB_TRUST_PROXY_KEY` (in `deploy/.env`, required by the override), which nginx sends from
  an include only root can read (the vhost files are everyone's):

  ```sh
  sudo install -d -m 700 /etc/nginx/book-club && sudo install -m 600 /dev/null /etc/nginx/book-club/proxy-key.conf
  key=$(sed -n 's/^BOOKCLUB_TRUST_PROXY_KEY=//p' deploy/.env)
  printf 'proxy_set_header X-Bookclub-Proxy-Key "%s";\n' "$key" | sudo tee /etc/nginx/book-club/proxy-key.conf >/dev/null
  sudo nginx -t && sudo systemctl reload nginx
  ```
- **Behind a CDN** (Cloudflare, say: an A record to the host, SSL "Full (strict)"): uploads come in
  tus chunks of 8 MiB, under Cloudflare's 100 MB per request; the API and the media are `no-store`
  or `private`, which it does not cache; the server's heartbeat keeps the WebSocket busy; nginx
  must take the reader's address from the CDN's header (`CF-Connecting-IP`), so the sign-in limits
  stay per reader. A CDN that injects its own analytics script is refused by the app's CSP: a
  console error, nothing more.
- **The certificate** can be Let's Encrypt's, renewed by certbot with the host's others, over
  HTTP-01 through nginx: Cloudflare lets `/.well-known/acme-challenge/` reach port 80 even with
  "Always Use HTTPS" on (`sudo certbot renew --cert-name books.example.org --dry-run` to check).
  Getting the first one by DNS-01 puts it in place before the name moves to this host, so the move
  drops no request.
- **The owner** is made with `create-owner --password-stdin`; keep its address and password
  somewhere only root can read.
- **Backups** go to `deploy/backups` in the clone (`BOOKCLUB_BACKUPS`), an incremental set bounded
  to what is actually stored (D125). If the host has its own nightly backup of `/opt`, it copies
  that small, bounded tree off the machine too; a second, independent copy can go to S3 ("Offsite
  copy (S3)" below).

## This host's own settings

Nothing particular to one deployment lives in the repository: no host names, addresses, buckets,
keys or private networks. They live on the host, where a `git pull` (or the automatic deploy's
fast-forward) never touches them:

| Where | What |
|-------|------|
| `deploy/.env` (in the clone, git-ignored, mode 600) | every setting the stack reads (`deploy/.env.example` lists them), including its secrets |
| `deploy/backups/`, `deploy/livekit/livekit.yaml` (git-ignored) | the backup set; LiveKit's generated config |
| `~/.config/book-club/auto-deploy.env` (outside the clone) | the automatic deploy's own settings: this host's clone, its public address, and the compose files it runs, including the host's own override below (`deploy/auto-deploy.sh` documents each) |
| `~/.config/book-club/compose.host.yaml` (outside the clone) | a compose override with whatever only this host has, such as a name for a private model gateway on the host's own network |
| `/etc/book-club/offsite-s3.env` (root's, mode 600) | the offsite copy's bucket and AWS command ("Offsite copy (S3)") |

A host override is an ordinary compose file. For example, to let the app reach a gateway that only
this host knows by name (Cal's "Mantle gateway" below):

```yaml
# ~/.config/book-club/compose.host.yaml
services:
  app:
    extra_hosts:
      - "gateway.internal.example:host-gateway"
```

and, in `~/.config/book-club/auto-deploy.env` (plain `KEY=value` lines; nothing in it is run):

```sh
BOOKCLUB_DEPLOY_DIR=/opt/book-club
BOOKCLUB_DEPLOY_URL=https://books.example.org
BOOKCLUB_COMPOSE_FILES="deploy/compose.yaml deploy/compose.host-proxy.yaml /home/<user>/.config/book-club/compose.host.yaml"
# BOOKCLUB_DEPLOY_SELF_UPDATE=1   # install each deployed commit's deploy/auto-deploy.sh ("When the command changes")
```

Run by hand, pass the same files: `docker compose -f deploy/compose.yaml -f
deploy/compose.host-proxy.yaml -f ~/.config/book-club/compose.host.yaml --env-file deploy/.env ...`.

## Voice and listening together: self-hosted LiveKit

Voice channels and listening together (D153-D159) run on [LiveKit](https://livekit.io), self-hosted
in its own container beside the app, never a managed cloud LiveKit: nothing a club says in voice
leaves this host, and nobody's usage meters against an outside account. It is **optional** — every
line is commented out in `deploy/.env.example`, and the app reports itself as `{enabled: false}`
(`GET /api/livekit/config`) and simply hides voice in the UI until all three are set.

### Turning it on

1. Pick a subdomain for LiveKit's signalling connection: `rtc.<BOOKCLUB_HOST>`
   (`rtc.books.example.org`). It needs its own DNS A record at this host's address. **If the zone is
   behind a CDN such as Cloudflare, that record must be DNS-only (Cloudflare's grey cloud), not
   proxied**: the signalling connection is a normal `wss://` request a CDN can proxy, but the
   real-time media that rides beside it (UDP) cannot, and the CDN would otherwise intercept the one
   without carrying the other, breaking every call. The app's own name (`BOOKCLUB_HOST`) is
   unaffected and can stay proxied.
2. Fill in every `BOOKCLUB_LIVEKIT_*` line in `deploy/.env` (`deploy/.env.example` documents each):
   an API key and secret you generate (`openssl rand -hex 16`, `openssl rand -base64 32`), this
   host's public IPv4 (`curl -4 ifconfig.me`), and `BOOKCLUB_LIVEKIT_URL=wss://rtc.<BOOKCLUB_HOST>`.
3. Generate the config LiveKit actually reads from those variables (D159: a generated file, never
   edited by hand, `.gitignored` because it holds the secret):
   ```sh
   set -a; . deploy/.env; set +a
   deploy/livekit/generate-config.sh
   ```
4. Add LiveKit's nginx site (same recipe as the app's own; `deploy/nginx/rtc.books.example.org.conf`
   has the commands) and open exactly these host ports, nothing wider:

   | Port | Protocol | Reachable from | Carries |
   |------|----------|-----------------|---------|
   | 443 | TCP | the internet | `rtc.<host>`'s HTTPS/wss, terminated by nginx, proxied to LiveKit's loopback `7880` (`BOOKCLUB_LIVEKIT_PORT`) — no new firewall rule, it is the port nginx already has open |
   | 7881 | TCP | the internet | LiveKit's own TCP fallback for a client ICE cannot reach by UDP (`BOOKCLUB_LIVEKIT_TCP_PORT`) |
   | 7882 | UDP | the internet | the actual call audio: one mux port, not a range (D159) |

   Real-time media cannot go through nginx (no reverse proxy forwards a raw UDP/ICE flow), so 7881
   and 7882 are published straight off the container (`deploy/compose.yaml`'s `livekit` service),
   bypassing the loopback-only pattern the app itself uses. That is the one deliberate exception in
   this kit, and it is scoped to exactly these two ports. LiveKit also supports an embedded TURN
   server (TLS on 443) for the networks a plain UDP/TCP fallback still cannot reach (some corporate
   Wi-Fi, some carrier NATs); it is not enabled here because it would need its own certificate and a
   second listener on 443, which the host's web server may already own — if a club hits networks
   the TCP fallback cannot cross either, point `turn.domain`/`turn.tls_port` at a free port and
   adjust the firewall rule above (LiveKit's docs call this out as the deployment's next step up).
5. Bring the stack up with the `livekit` profile added (it is opt-in, D159's `profiles:` on the
   service):
   ```sh
   docker compose -f deploy/compose.yaml --env-file deploy/.env --profile livekit up -d --build --wait
   ```

### What each piece is for

- **The browser never asks this app to relay voice or audio.** It asks `/api/livekit/token` for a
  short-lived token (membership-checked, scoped to a room name the server built), then dials
  `BOOKCLUB_LIVEKIT_URL` itself. The audiobook during a listening party is never published to
  LiveKit either (D155): it plays locally, from each listener's own authenticated media, synced to
  the server's clock.
- **Voice presence** (who has joined, muted, speaking) is each client's own report over the
  existing hub, not polled from LiveKit (D154): accurate the instant it changes, and it needs no
  LiveKit webhook to work at all.
- **The webhook** (`/api/livekit/webhook`, `BOOKCLUB_LIVEKIT_WEBHOOK_URL`, reached over the
  compose network, never published) is an optional backstop: it only cleans up a participant
  LiveKit confirms is gone when a client's own socket has not noticed yet (a network partition the
  RTC connection saw sooner than a 20 s heartbeat). Dropping it changes nothing but that one edge
  case's latency.
- **Auto-pause on interruption** (D158) runs entirely on this server from each client's own report
  of its own mic — it needs no LiveKit feature beyond the active-speaker events every client
  already gets. It is sharply limited to that: it cannot tell a real voice from the audiobook
  leaking out of one device's speaker into another's microphone, since echo cancellation only
  removes a device's own output from its own mic. Earbuds remove that leak at the source and are
  the practical fix; this is documented again in `packages/shared/src/live/autopause.ts`.

### The demo stack

`compose.yaml` (the one `docker compose up` without `-f` uses) runs a *dev*-mode LiveKit
(`livekit-server --dev`) with a fixed demo key and secret (`LIVEKIT_KEYS`) and no TLS — fine for a
laptop, never for anything reachable from the internet. It is always on (no profile) so the demo
shows chat, voice and listening together with no extra setup.

## One identity: continuing with an upstream account

Friends who already have an account at another site you run (an upstream identity provider)
continue with it instead of making one here (D14, D116), through the upstream's app sign-in grant
for Book Club: an authorization code with PKCE (RFC 7636, S256). "Continue with <name>"
(`BOOKCLUB_UPSTREAM_NAME`) sends the browser to the upstream's start address with a one-time state
and a PKCE challenge; the upstream signs the person in on its own pages and sends the browser back
to Book Club's callback, `https://<BOOKCLUB_HOST>/api/auth/upstream/callback`, with a code good
once, for 90 seconds; Book Club's server redeems it at the upstream's exchange address with the
verifier that only that browser's cookie held, and is told the person's id, name and verified
address. No upstream secret is kept here, no cookie is shared, and the upstream keeps no session
for Book Club. The upstream should have that callback fixed for its client `book-club`, so its
grant serves your Book Club and nowhere else. (v1's way, D52, read the upstream's shared cookie;
that is gone.)

What the upstream has to implement is exactly what the stand-in in
`tools/fake-upstream/server.mjs` does (the demo stack and the tests run against it, and its header
documents each route): `GET .../api/auth/book-club/start?state=…&code_challenge=…&code_challenge_method=S256`,
which signs the person in and sends the browser back to the callback with `state` and a `code`
(or `error=failed`); `POST .../api/auth/book-club/exchange` with `{ code, codeVerifier }`, which
answers who it is; and, optionally, the password check below.

To switch it on, add the two addresses to `deploy/.env`, and recreate the app, which reads its
settings only as it starts (`restart` would keep the old ones):

```sh
cat >> deploy/.env <<'EOF'
BOOKCLUB_UPSTREAM_START_URL=https://id.example.com/api/auth/book-club/start
BOOKCLUB_UPSTREAM_EXCHANGE_URL=https://id.example.com/api/auth/book-club/exchange
BOOKCLUB_UPSTREAM_NAME=Example ID
EOF
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --wait app
curl -s https://books.example.org/api/session    # ..."upstream":{"name":"Example ID"}
```

### An upstream password, typed here (D173)

The iOS app's WebView cannot bounce to the upstream's own sign-in page and come back ("Continue
with ..." there never returns to the app). So the upstream can serve a password endpoint next to
the grant above, `POST /api/auth/book-club/password`, server to server only: this app sends it the
email and password typed into its own sign-in form plus a fresh PKCE challenge, gets back a code
bound to that challenge exactly as the browser flow hands one over, and redeems it at the exchange
address above — the same identity exchange, unchanged. The password itself goes to the upstream
and nowhere else; this app never stores it.

That endpoint is a credential check, so the upstream must refuse it to anyone but this server:
every request carries `Authorization: Bearer <BOOKCLUB_UPSTREAM_PASSWORD_SECRET>` and an
`X-Book-Club-Client-Ip` header naming the real person this server is asking on behalf of (for the
upstream to rate-limit on that address and the attempted email together, plus a looser cap on the
email alone). A wrong or missing secret on either side is a 401 (this app's) or, as the stand-in
does it, a 404 (the upstream's, as if the route did not exist).

Once the upstream serves it with the identical secret configured on its side, add both lines and
recreate the app the same way:

```sh
cat >> deploy/.env <<'EOF'
BOOKCLUB_UPSTREAM_PASSWORD_URL=https://id.example.com/api/auth/book-club/password
BOOKCLUB_UPSTREAM_PASSWORD_SECRET=
EOF
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --wait app
```

Leaving these two lines out keeps "Continue with ..." as the only way to sign in with an upstream
account; the sign-in form never offers an upstream password it cannot check. On top of the
upstream's own limits, this app still applies its own per-address-and-email sign-in limiter, and
its own separate per-address-and-email budget for the password check itself (kept apart from the
callback's own exchange budget below, so a run of password guesses cannot lock out "Continue
with ..." sign-ins, or the reverse), to every attempt, upstream password or local.

Then "Continue with ..." shows on the sign-in page and on invites, and goes to the upstream and
back. To switch it off, delete the lines and run the same `up`. A `deploy/.env` that still has the
old cookie flow's lines (`BOOKCLUB_UPSTREAM_JWT_SECRET`, `_JWT_ISSUER`, `_JWT_AUDIENCE`, `_COOKIE`,
`_LOGIN_URL`) stops compose with a message naming them, before anything on the host changes:
delete them. An upstream typically limits how many sign-in exchanges one address may make, and
every Book Club sign-in comes from this server's address, so after `SIGNIN_ATTEMPTS` (10) codes
from one browser address that sign nobody in, Book Club redeems none from it for the rest of the
15 minutes (sign-ins that work are not counted).

## Cal (Callimachus): the club's AI assistant

Cal is off (every `/api/*/cal/*` route 404s, the web app never shows him) until `deploy/.env` has
an Anthropic key. Add what you want to use (deploy/compose.yaml passes each `BOOKCLUB_*` line to the
app as the name without the prefix) and recreate the app:

```sh
cat >> deploy/.env <<'EOF'
BOOKCLUB_ANTHROPIC_API_KEY=sk-ant-...
# BOOKCLUB_CAL_EFFORT=low                    # adaptive thinking, low effort by default
# BOOKCLUB_CAL_MODEL=claude-opus-5-5          # default; any current Claude model works
# BOOKCLUB_CAL_EMBEDDING_PROVIDER=openai      # openai | gemini | fake (fake needs no key; tests only)
BOOKCLUB_OPENAI_API_KEY=sk-...                # for CAL_EMBEDDING_PROVIDER=openai (the default) and/or CAL_STT_PROVIDER/CAL_TTS_PROVIDER=openai
# BOOKCLUB_GOOGLE_API_KEY=...                 # for CAL_EMBEDDING_PROVIDER=gemini
# BOOKCLUB_CAL_STT_PROVIDER=elevenlabs        # elevenlabs | openai | fake (default elevenlabs; D167)
# BOOKCLUB_CAL_TTS_PROVIDER=elevenlabs        # elevenlabs | openai | fake (default elevenlabs; D167)
BOOKCLUB_ELEVENLABS_API_KEY=...               # for CAL_STT_PROVIDER/CAL_TTS_PROVIDER=elevenlabs (the default)
# BOOKCLUB_ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb  # default "George"; any ElevenLabs voice id from your account's /v1/voices
# BOOKCLUB_CAL_NARRATOR_VOICES=true         # answer an audiobook's listeners in its narrator's voice, where it has one (D223)
# BOOKCLUB_CAL_TTS_CACHE_MB=256             # spoken replies kept on disk (derived/tts-cache); 0 keeps none
# BOOKCLUB_CAL_TTS_CACHE_DAYS=30            # and for at most this long
# BOOKCLUB_CAL_WEB_SEARCH=true                # Anthropic's server-side web search tool
# BOOKCLUB_CAL_RATE_LIMIT_PER_MINUTE=20       # chat or voice turns one member may start per minute
# BOOKCLUB_CAL_MONTHLY_SPEND_CAP_USD=20       # a club's logged Cal spend (cal_cost_log) resets each calendar month
EOF
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --wait app
```

### Cal in the narrator's voice

A listener who stops the audiobook to ask Cal something hears his answer in the narrator's voice
(D223), where the book has one; every other answer is in Cal's own (`ELEVENLABS_VOICE_ID`). A book
is given one from the host, with ElevenLabs as the TTS provider, in one of three ways, used in this
order once set:

1. **(a) The narration is ElevenLabs speech.** Give its voice id: the answer is the very voice.
2. **(c) A clone the narrator agreed to.** Only with their consent, recorded with the voice; the
   database refuses a clone without it. Never clone a narrator from a commercial recording.
3. **(b) A designed voice.** Otherwise: ElevenLabs Voice Design makes a voice from a description of
   the narrator (gender, age, accent, pace, timbre). The recording is only measured on this host
   (pace from its transcript, pitch with ffmpeg), never sent: the design request cannot carry audio.

```sh
bc() { docker compose -f deploy/compose.yaml -f deploy/compose.host-proxy.yaml --env-file deploy/.env "$@"; }
bc exec -T app bookclub narrator-voice show
# (b): three previews, the one nearest the narration's pitch kept, its speed set to the narrator's pace
bc exec -T app bookclub narrator-voice design --book BOOK_ID \
  --description 'A man in his forties, a low, gravelly English baritone; intense and measured, recorded close to the microphone.' --out /data/tmp/previews
# (a) / (c) / settings
bc exec -T app bookclub narrator-voice set --book BOOK_ID --narration-voice-id VOICE_ID
bc exec -T app bookclub narrator-voice set --book BOOK_ID --designed-voice-id VOICE_ID   # (b) the same narrator's voice, for another book of the series
bc exec -T app bookclub narrator-voice set --book BOOK_ID --clone-voice-id VOICE_ID --consent 'Who agreed, when, how'
bc exec -T app bookclub narrator-voice set --book BOOK_ID --stability 0.55 --style 0.1 --speed 0.9
bc exec -T app bookclub narrator-voice calibrate --book BOOK_ID   # time its voice again: speed and player rate for the narrator's pace
bc exec -T app bookclub narrator-voice say --book BOOK_ID --text 'A test line.' --out /data/tmp/say.mp3
bc exec -T app bookclub narrator-voice remove --book BOOK_ID          # back to Cal's own voice
```

`design` designs up to three rounds (`--rounds N`) while no preview is within two semitones of the
narration's pitch, each round with its own seed (`--design-seed N` repeats a run's first);
`--pick N` keeps preview N instead (listen to them in `--out`). The description matters most: a
register word ("baritone", "medium-high") lands nearer than an extreme one ("very deep, gravelly"). A designed or cloned voice is
kept in the ElevenLabs account under "Book Club: <title>"; `remove` leaves it there. The web app says
when an answer is in a voice made to sound like the narrator, and that it is not them.

The SDK client rejects ambient `ANTHROPIC_CUSTOM_HEADERS` rather than allowing shell/CLI settings
to override server authentication or accounting. SDK logging and telemetry are explicitly disabled.

**Through a scoped gateway.** For an Anthropic-compatible gateway (an Amazon Bedrock Mantle
endpoint, or a private gateway in front of one), keep the gateway's client credential in
`deploy/.env` (never in Git or browser/mobile config), and set these explicit server settings:

```dotenv
BOOKCLUB_ANTHROPIC_API_KEY=<the gateway's scoped client credential>
BOOKCLUB_ANTHROPIC_BASE_URL=https://gateway.internal.example/anthropic
BOOKCLUB_ANTHROPIC_AUTH_MODE=bearer
BOOKCLUB_ANTHROPIC_TENANT_ID=<your-tenant>
BOOKCLUB_ANTHROPIC_TENANT_HEADER=x-gateway-tenant   # the header your gateway reads the tenant from (this is the default)
BOOKCLUB_CAL_MODEL=anthropic.claude-opus-5-5
BOOKCLUB_CAL_EFFORT=low
BOOKCLUB_CAL_WEB_SEARCH=false
```

A gateway reachable only on the host's own network gets its name from the host's own compose
override (`extra_hosts`, "This host's own settings" above); put a relay in front of it that admits
only the Docker bridge's addresses and only the exact message/Responses POSTs Cal makes, and never
publish the gateway or its credential. Use HTTPS for any endpoint that is not on the host itself.
The tenant is an operator-assigned accounting identity, not a user-controlled field. Normal
Anthropic installs keep the pinned official endpoint and API-key authentication. Every Cal
chat/voice-brain model call sends adaptive thinking and an explicit `output_config.effort`;
embeddings, STT and TTS keep their own providers. Mantle-prefixed model ids use the same family
price for the spend caps. Web search is a separate setting; a gateway route that rejects the
web-search tool needs it off, as above. Cal's own library tools remain available.

Optional Mantle Sol fallback (chat and the voice brain, not embeddings/STT/TTS), on the same
gateway origin:

```dotenv
BOOKCLUB_CAL_SOL_BASE_URL=https://gateway.internal.example/openai
BOOKCLUB_CAL_SOL_MODEL=openai.gpt-6.1-sol
BOOKCLUB_CAL_SOL_INPUT_USD_PER_MILLION=6
BOOKCLUB_CAL_SOL_OUTPUT_USD_PER_MILLION=20
```

Sol uses its own native `/openai/v1/responses` route with `reasoning.effort=low`, `store=false`,
the primary's scoped credential and tenant, and translated custom tools. `service_tier=default`
prevents premium-tier charges. The endpoint must share the primary's configured origin; no ambient
OpenAI credentials or endpoint/profile settings are inherited, and redirects are rejected. Fallback
happens once, only on capacity/connectivity failures (429/5xx/SDK connection errors), before any
primary stream message, answer text or completed tool turn. A started thinking stream also fences
fallback rather than hiding unaccounted primary usage. It never retries a refusal,
authentication/configuration error, cancellation, partial answer or executed tools. Once selected,
Sol remains active through that answer's tool loop. The same six-turn bound and citation/spoiler
checks remain. Failed/truncated Sol streams do not fabricate completion. No automatic fallback back
to Opus is attempted in that answer.

The numbers above are explicit **conservative spend-guard estimates**, using $6/M input and $20/M
output to bound AWS-published Standard long-context rates, including cache writes. Standard tier is
pinned explicitly; these are estimates, not a billing invoice. Replace them with verified account
prices when available. Actual Sol token usage is recorded under `mantle-sol`/its exact model;
monthly caps are unchanged. AWS source checked 2026-10-30:
https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html#model-card-openai-gpt-6-1-sol-pricing
Leaving the endpoint unset disables this fallback.

`CAL_TEST_FAKE_MODEL` (default off) is for the E2E suite only (`e2e/tests/cal.spec.ts`): it answers
through a deterministic stand-in instead of calling Anthropic, so the suite can run without a key
or real spend. **Never set it in `deploy/.env`.** With it, `CAL_TEST_FAKE_MODEL_DELAY_MS` (default 0)
slows each of the stand-in's turns in the club's chat (D204), so `e2e/tests/chat-cal.spec.ts` can see
"Cal is typing"; the repository's `compose.yaml` sets it to 1000.

Cal answers in the club's chat too (D204), wherever he is set up: a member @-mentions him (`@cal`)
and he answers in the thread, from what that member has read of the channel's book (never his shelf or
the web there, which could not be held to a spoiler fence), within the same rate limit
(`CAL_RATE_LIMIT_PER_MINUTE`, counted apart from his panel's) and the same monthly caps. Nothing
more to configure.

Every embedding batch, chat turn and voice call is logged to `cal_cost_log` with its provider's
published price; `CAL_MONTHLY_SPEND_CAP_USD` blocks new Cal turns for a club once its calendar-
month total reaches it (D168). Measured embedding/vector-search and voice-provider latency
numbers: docs/DECISIONS.md D161 and D167.

## Agents in chat: an agent of another service, @-mentioned

An agent you run elsewhere (Lux is the first) can take part in a club's chat (D205): a member
@-mentions it, Book Club POSTs that message, signed, to the agent's webhook with the conversation it
is in (as that member may read it), and the agent answers through Book Club's agent API with a
bearer token of its own. Book Club decides nothing about what an agent is asked; it delivers the
message and shows the answer. Each agent is one entry of one JSON array, on one line, single-quoted
so that compose takes it as it is:

```sh
cat >> deploy/.env <<'EOF'
BOOKCLUB_CHAT_AGENTS='[{"handle":"lux","name":"Lux","about":"Takes requests for features and changes to Book Club.","avatar":"🦊","webhookUrl":"https://agent.example.org/book-club/hook","webhookSecret":"<openssl rand -base64 32>","token":"<another openssl rand -base64 32>","clubs":["<club id>"]}]'
EOF
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --wait app
```

- `handle`: what members type after `@` (2 to 32 lowercase letters, digits or `_`; `cal` is Cal's).
  `name`, `about` (shown in the @ picker, followed by a line saying that a message naming it is sent
  outside Book Club), `avatar` (one or two characters, or a `data:image/png|jpeg|webp|gif;base64,…`
  picture of 48 KB at most; the app shows images from nowhere else).
- `clubs`: the ids of the clubs it is in (a club's id is in its address, `/clubs/<id>`), or `"*"`
  for every club on this server: only where every club is yours, since a message naming it leaves
  Book Club. Optional: `perMemberPerMinute` (4) and `perMinute` (30), messages it is sent a minute.
- `webhookSecret` signs each delivery and `token` is what the agent answers with: 32 characters at
  least, and every one different, the two of one agent and those of every other agent alike. Book
  Club refuses to start on a mistake here, saying which, never the value.

**What the agent receives.** `POST` to `webhookUrl`, JSON (`AgentEventV1` in
`@coletebou/chat-core`'s `agents.ts`, github.com/coletebou/chat-core), with `x-agent-event: chat.mention`, `x-agent-delivery` (the same
on every retry of it), `x-agent-timestamp` (Unix seconds) and `x-agent-signature: v1=<hex>`: the
HMAC-SHA256, keyed by `webhookSecret`, of the timestamp, a full stop and the raw body. Check it over
the raw body, refuse a timestamp more than five minutes off, and answer 2xx at once; chat-core's
`verifyAgentWebhook` does all three checks, and `tools/fake-agent/server.mjs` is a whole receiver in
one file. Book Club never follows a redirect, waits ten seconds, tries again twice after a network
failure, a 429 or a 5xx (after 1 s and 4 s; each retry built again from the conversation as it is
then, under the same `x-agent-delivery`), and tells the asker when it never got through.

**On the agent's side.** Give the agent Book Club's address in its own configuration (the stand-in
reads `BOOKCLUB_API`): an event names no address, only paths on Book Club's API (`reply.path`, a
picture's `path`), each starting with a single `/`. Join a path to that address, never resolve it
against one, and send the token nowhere else. Answer each delivery from what it carried: Book Club
fences an answer at the furthest fence of what it delivered for that message (at the asker's place,
so they can read it), and a message of the agent's own in a book's channel at the furthest fence it
was ever given there. Something drawn from several deliveries belongs in a message of its own in
that book's channel, and nothing from a book's channel belongs in General, which has no fences.

**How it answers** (`Authorization: Bearer <token>`, JSON; 120 requests a minute):

| Request | What it does |
|---|---|
| `POST /api/agents/v1/clubs/:clubId/messages` | `{ "text", "parentId"?, "bookId"?, "clientId"? }`: a reply in the thread of `parentId`, a message delivered to it (the event's `reply` says where and to what; any other is a 404), or a message of its own in a channel; the same `clientId` twice posts once |
| `PATCH /api/agents/v1/messages/:id` | `{ "text" }`: one of its own, fenced again as it would be now, never lower |
| `POST /api/agents/v1/clubs/:clubId/typing` | `{ "bookId"? }`: "Lux is typing" in that channel for five seconds |
| `GET /api/agents/v1/media/:id?expires=&signature=` | a picture of a delivered message, by the address the event gives (good for an hour) |
| `GET /api/agents/v1/me` | its handle, name and clubs: a check that the token works |

## Push to the iOS app

The app (`apps/mobile`) registers its device with `/api/push/register`; the server sends over its
own connection to Apple when it creates a notification. No Expo account is involved (D134): this
is the team's own `.p8` key, APNs' token (JWT) auth. To switch it on, add four lines to
`deploy/.env` and recreate the app:

```sh
cat >> deploy/.env <<'EOF'
BOOKCLUB_APNS_KEY_ID=ABCD1234EF
BOOKCLUB_APNS_TEAM_ID=TEAM123456
BOOKCLUB_APNS_BUNDLE_ID=com.example.bookclub
BOOKCLUB_APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
EOF
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --wait app
```

`BOOKCLUB_APNS_BUNDLE_ID` is the bundle id of the iOS app you build and ship (`apps/mobile`'s
`BUNDLE_ID`); Apple refuses a push whose topic disagrees with it. `BOOKCLUB_APNS_PRIVATE_KEY`
carries the key with literal `\n`s (compose's `.env` files have no real newlines); the server
unescapes them before parsing the PEM. `BOOKCLUB_APNS_PRODUCTION` defaults to `true` here (Apple's
production APNs host) — the app's own `BOOKCLUB_APS_ENVIRONMENT` (a build-time setting,
`apps/mobile/scripts/archive.sh`) must agree, or Apple refuses every push with "BadDeviceToken": a
TestFlight/App Store build is `production`; every other build (the simulator, an ad-hoc export) is
`development` and needs Apple's *sandbox* APNs host instead (`BOOKCLUB_APNS_PRODUCTION=false` on
whatever server that build points at). Unset any of the four and push is simply off; the in-app
bell is unaffected either way. Never commit the key: it goes in `deploy/.env` only, which
`.gitignore` already excludes.

## Backups

The `backup` service runs `bookclub backup --set /backups --keep $BOOKCLUB_BACKUP_KEEP` (default
14) every `BOOKCLUB_BACKUP_EVERY_HOURS` (24): an incremental, content-addressed backup *set*
(D125), not a pile of full copies. Each run writes one dated, gzip'd SQLite snapshot
(`VACUUM INTO`, checked with `PRAGMA integrity_check`) to `BOOKCLUB_BACKUPS/db/`, copies whatever
blobs and publication files that snapshot needs into `BOOKCLUB_BACKUPS/files/blobs/` and
`.../files/pubs/` (by content hash, so a file already there is never copied again), then prunes
every stored file no kept snapshot still needs. Copy `BOOKCLUB_BACKUPS` off the host (rsync, a
cloud drive, the S3 copy below): a backup on the same disk is not one.

**Size.** The set tracks what is actually stored, roughly once, not `keep` times the whole
library: a metadata-only club is a few hundred KB; a long series of audiobooks (six-plus at
0.5-1 GB each, plus EPUBs) would be a few GB once, not 14x that. The old single-file archives
(below) ran `BOOKCLUB_BACKUP_KEEP` × the whole data directory — the reason this changed
(docs/DECISIONS.md D125).

A backup now, like the daily ones, as the app's user (`--user node`: the service starts as root
only to hand the backup directory over, and that root may not read or write the app's files);
`umask 077` keeps it readable by the app's user alone:

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env exec --user node backup \
  sh -c 'umask 077 && bookclub backup --set /backups --keep 14'
```

Prune on its own (e.g. right after lowering `BOOKCLUB_BACKUP_KEEP`, without waiting for the next
scheduled backup):

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env exec --user node backup \
  bookclub prune --set /backups --keep 14
```

A **single portable file** still works too, beside the set (D127) — for a drill, or to carry a
backup to a new host as one artifact (not a directory tree whose files point into a store the new
host does not have):

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env exec --user node backup \
  sh -c 'umask 077 && bookclub backup --out /backups/now.tar.gz'
```

**The host's own backup.** On a host whose own nightly job backs up the whole directory tree, that
job copies the same bounded, incremental set every night instead of `BOOKCLUB_BACKUP_KEEP` full
copies: nothing to change there (D125).

## Restoring

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env stop app
docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm --no-deps --user node backup \
  'bookclub restore --from-set /backups --force'
docker compose -f deploy/compose.yaml --env-file deploy/.env start app
```

Restores the set's newest snapshot; `--at 20261023T030000Z` (a snapshot's own timestamp, or a
prefix of one) restores its newest snapshot at or before that UTC time instead. As the app's user
again, so that it can read the set and the restored files are its own. As strict as the one-file
restore below: the chosen snapshot's database is unpacked beside the data and checked
(`PRAGMA integrity_check`), every blob and publication file it names must be in the set's stores,
and nothing but regular files land under `bookclub.db`, `blobs` and `pubs` — before anything
beside the data is touched, so a damaged or incomplete set leaves the current data exactly as it
was.

A single-file archive (`--out`, above) restores the same way, strict in the same ways:

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm --no-deps --user node backup \
  'bookclub restore --from /backups/now.tar.gz --force'
```

The drill below runs both restore paths.

## Offsite copy (S3)

A second, independent copy, off this host entirely, in S3 (or any S3-compatible store), beside
whatever backup the host itself has (D129). `deploy/offsite/bookclub-offsite-s3.sh` runs as the
deploy account after the daily backup (`bookclub-offsite-s3.timer`, systemd) and `aws s3 sync`s
the incremental set (never the single-file archives — those are for drills and moves, not
continuous backup) to `s3://$BOOKCLUB_OFFSITE_BUCKET/$BOOKCLUB_OFFSITE_PREFIX/`: `db/` to a
`daily/` prefix (a lifecycle rule expires these by age, below), `files/` to a `files/` prefix
(content-addressed, so the sync only ever uploads what changed). It never passes `--delete` — the
identity it runs as has no `s3:DeleteObject` on the bucket, by design (below) — and it is safe to
run on any schedule: it only ever uploads a file the backup already renamed into place, never one
still being written, and it touches no local data either way.

Install (once the bucket and IAM policy below exist; the units assume the clone is
`/opt/book-club` and the deploy account is `deploy`: edit their `User=`, `Group=` and paths
otherwise):

```sh
cd /opt/book-club
sudo install -d -m 755 /etc/book-club
sudo install -m 600 /dev/null /etc/book-club/offsite-s3.env
sudo tee /etc/book-club/offsite-s3.env >/dev/null <<'EOF'
BOOKCLUB_OFFSITE_BUCKET=your-bucket
BOOKCLUB_OFFSITE_PREFIX=book-club
# The AWS CLI as this host runs it: a profile, a credential wrapper, or another S3 endpoint.
BOOKCLUB_OFFSITE_AWS=aws --profile book-club-offsite
EOF
sudo cp deploy/offsite/bookclub-offsite-s3.service deploy/offsite/bookclub-offsite-s3.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bookclub-offsite-s3.timer
sudo systemctl start bookclub-offsite-s3.service   # a sync now, instead of waiting for the timer
journalctl -u bookclub-offsite-s3.service -n 20
```

**One-time setup, by an admin.** The identity the sync runs as should not be able to create a
bucket or touch IAM, so automation here can only ever add and read, never delete or reconfigure
what protects it (D129). Someone with real AWS rights runs this once, before the timer above is
enabled:

```sh
BUCKET=your-bucket
REGION=us-east-1

aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"

# No public access, ever.
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Versioning: a safety net against an overwrite, not a path this sync relies on (it never
# overwrites a given key — content-addressed files are immutable, and a daily snapshot's name
# is unique to its run), but cheap insurance against a mistake made with real IAM rights later.
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration '{
  "Rules": [{ "ApplyServerSideEncryptionByDefault": { "SSEAlgorithm": "AES256" } }]
}'

# daily/ (the SQLite snapshots) ages out on its own, bounding the offsite copy even though the
# sync that writes it cannot delete (D129); files/ (blobs, publication files) has no age-based
# rule — it accumulates until an admin with real S3 rights prunes it by hand, a known tradeoff
# for never granting this automation delete rights.
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{
  "Rules": [
    { "ID": "expire-daily-snapshots", "Status": "Enabled", "Filter": { "Prefix": "book-club/daily/" }, "Expiration": { "Days": 90 } },
    { "ID": "expire-noncurrent-versions", "Status": "Enabled", "Filter": { "Prefix": "" }, "NoncurrentVersionExpiration": { "NoncurrentDays": 30 } },
    { "ID": "abort-incomplete-multipart", "Status": "Enabled", "Filter": { "Prefix": "" }, "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 2 } }
  ]
}'
```

And the IAM policy statement the sync's identity needs — list the bucket, read and write under
`book-club/`, **no delete**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BookClubOffsiteBackupList",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::your-bucket",
      "Condition": { "StringLike": { "s3:prefix": ["book-club/*"] } }
    },
    {
      "Sid": "BookClubOffsiteBackupObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::your-bucket/book-club/*"
    }
  ]
}
```

**Restoring from S3**, on any host with the same AWS access (sync down, then the usual
`restore --from-set`):

```sh
mkdir -p /tmp/bookclub-restore/db /tmp/bookclub-restore/files
aws s3 sync s3://your-bucket/book-club/daily/ /tmp/bookclub-restore/db/
aws s3 sync s3://your-bucket/book-club/files/ /tmp/bookclub-restore/files/
docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm --no-deps --user node backup \
  "bookclub restore --from-set /tmp/bookclub-restore --force"
```

Tested for real against a local S3-API-compatible server (sync up, sync down, `restore
--from-set`, the restored app serving the same club, book and progress) — see the drill below and
docs/RUNBOOK.md.

## The drill

`scripts/deploy-drill.sh` runs the production compose file on this machine as project
`bookclubv2-drill`, with Caddy's own certificate authority (`BOOKCLUB_TLS=internal`) for
`books.localhost` on 127.0.0.1:47443, from an image of its own (`bookclubv2-drill:runtime`, built
with the recogniser as the kit builds it, D79; any `deploy/.env` is ignored). It needs Docker,
ffmpeg and the LibriVox Alice tracks (`scripts/fetch-librivox.sh`), and checks, in order:

1. the stack starts healthy; HTTPS answers with a certificate the drill's authority signed (and
   curl refuses it without that authority), with HSTS;
2. nobody can claim the empty instance from the browser; an owner is created with the CLI;
   signing in over HTTPS sets a Secure session cookie; a WebSocket through the proxy says hello;
3. a book is uploaded over HTTPS with tus and becomes ready; the file it serves is byte for byte
   the one uploaded; a reading position is saved;
4. an audiobook of it (ten seconds of each of the twelve LibriVox chapters) is uploaded, and the
   recogniser in the image transcribes it and the server lines it up with the book, running as the
   app's user at the lowest priority;
5. an incremental backup set is made while the app runs (`backup --set`, D125), and so is a
   single, portable file (`backup --out`, D127), restored into a scratch directory to prove it
   still works; the daily loop has made its own set too, readable by the app's user only, under
   no-new-privileges;
6. the set is pruned to its newest snapshot (`bookclub prune --set`);
7. every volume is deleted; the empty server refuses the owner; the pruned snapshot survives
   (it is bind-mounted, not a volume) — the daily loop may already have made another, empty one
   of the freshly recreated app the moment it came back healthy, itself a sign the loop keeps
   working through this;
8. that snapshot (named explicitly, by timestamp, so the live loop's newer-but-empty one is never
   picked by mistake) is restored into the stopped app with `restore --from-set`, then it starts;
   signing in works again, the book, its file (identical), the reading position and the
   audiobook's read-along are back.

A run on a development host (2026-10-28, the build's own lines left out):

```
up after 12s
HTTP/2 200
strict-transport-security: max-age=31536000
setup from the browser: HTTP 403
created owner@drill.test with club "Drill club"
cookie: __Host-bc_session secure flag: TRUE
websocket over TLS: hello for ecJNDKNo2-FN1vO-
book mZt7RSyLGiO5PGnH ready; the file served over HTTPS is the uploaded one: yes
recogniser: nice -n 19 /opt/align/venv/bin/python -I /opt/align/transcribe.py --model /opt/align/models/base.en --offline --threads 2
audiobook FxqpaDm29vGpSUdf: 12 tracks, 120.4 s of the LibriVox recording, ready after 2s
transcribed and lined up after 15s: 23 sentences, 1.24 % of the book's words heard and matched
the server's job took 13.4s for 120.4 s of audio; heard 341 words, matched 332, tracks lined up 10 of 12
recogniser seen running: uid 1000 nice 19
backup set updated: /backups (snapshot bookclub-20261028T101837Z.db.gz, 14432 bytes; 14 of 14 file(s) copied, 56 of 56 publication file(s) copied; pruned 0 old snapshot(s), freed 0 file(s), 0 bytes)
incremental snapshot: bookclub-20261028T101837Z.db.gz, mode 600
backup loop: Uid: 1000 1000 1000 1000;NoNewPrivs: 1
backup written: /backups/drill.tar.gz (1602305 bytes)
pruned 1 old snapshot(s) from /backups: 0 file(s) freed, 0 bytes
pruned to one snapshot: bookclub-20261028T101837Z.db.gz (20261028T101837Z)
sign-in on the empty server: HTTP 401
restored /backups (snapshot bookclub-20261028T101837Z.db.gz) into /data
book: Alice in the drill; my place: Chapter 3 · 15%; file identical: yes
the audiobook's read-along: 23 sentences
DRILL PASSED in 60s
```

## Checks and automatic deploys

**Checks.** `.github/workflows/check.yml` runs on GitHub-hosted runners (`ubuntu-latest`) for every
pull request, and is reused by the deploy workflow for master. It installs the frozen lockfile, runs
plain `oxlint`, sequential TypeScript checks, every non-E2E test suite, the OTA classifier's tests,
the recogniser tools' tests and the deployment script's scratch-repository regression tests.
Browser E2E (`e2e.yml`, run by hand: the demo stack and Playwright on a GitHub-hosted runner),
coverage and a native archive remain separate developer/release tasks, not this basic gate. Type-aware ESLint is `pnpm lint` locally and runs daily in CI (`lint-daily.yml`, 05:23 UTC,
`pnpm lint:daily`: fresh processes per eight-file, project-local batch, with 576 MiB heaps, so no
process ever holds every project's TypeScript program at once); it is not a pull request gate.

The CI scripts are written to fit in a 1 GiB job, the size of the self-hosted runners they were
first tuned on, and keep that bound on any runner. `scripts/test-ci.sh` (also `pnpm test:ci`) uses
one server/EPUB fork and two web/shared forks under a 128 MiB Vitest coordinator. The forks get no
old-generation heap flag and size it from the machine (or the job's cgroup): on Node 24 any
process-wide old-space flag, in `NODE_OPTIONS` or on the command line, replaces the
`resourceLimits` of every Worker that process starts, even one with `execArgv: []` (32 MiB asked,
280 MiB granted under `--max-old-space-size=256`), which would let the server's work-limit tests
pass for the wrong reason; `test/worker-limits.test.ts` fails fast if that happens. Three settings
that change no app limit keep the heaviest test files low: `UV_THREADPOOL_SIZE=2` (each sign-in
holds a 128 MB scrypt buffer on a pool thread; the sign-in limit tests fire four at once),
`MALLOC_ARENA_MAX=2` (freed worker-thread memory goes back) and `--max-semi-space-size=4` (smaller
young generations; the app's workers set only old-generation limits). The script's comments give
the measurements per file. `scripts/typecheck-ci.sh` checks every workspace project plus tools
sequentially, with compiler-only heap flags that never reach tests.

**Who can run what.** No code from a pull request ever runs on a machine of the project's own:
`check.yml` is the only workflow a pull request triggers, and it names no self-hosted runner. The
repository requires a maintainer's approval before workflows run for any outside contributor's pull
request, so a pull request that adds a workflow of its own waits for someone to read it first.

**Deploys.** `deploy.yml` runs only on master pushes (or a manual run on master): never
`pull_request` or `pull_request_target`. Its checks must pass before its secret-bearing job runs on
a self-hosted runner on the production host, in the `production` environment, whose deployment
branch policy allows master only. That job runs only where the repository variable
`BOOKCLUB_DEPLOY_ENABLED` is `true`: a fork, which has neither the variable nor the runner, skips it
instead of queueing for a runner that never comes. The runner is registered to this repository
with the single label `personal-linux-trusted` and no default labels, so nothing that asks for
`self-hosted` or `ubuntu-latest` can land on it, and it runs as an unprivileged account with
neither Docker nor sudo. It SSHes to the deploy account on `127.0.0.1` with an environment key
restricted to the host itself, with no shell or forwarding and one forced command. `SSH_HOST`,
`SSH_USER`, `SSH_PRIVATE_KEY` and the pinned host key `SSH_KNOWN_HOSTS` are environment secrets;
the workflow removes the private key and known-hosts file from its job temp directory even on
failure. It copies no production configuration from the runner. The mobile OTA workflow
(`ota-update.yml`, after a successful deploy) runs on the same runner and environment, and only
for this repository's own push or manual deploys of master (it checks the triggering run's event
and repository, since `workflow_run` also fires for runs that pull requests start).

Setting it up on a host, once:

1. **The runner**: register a self-hosted runner to the repository as an unprivileged account
   (`./config.sh --url https://github.com/<owner>/<repo> --labels personal-linux-trusted
   --no-default-labels`), and run it as a service.
2. **The forced command**, installed by the deploy account itself (a repository update must not
   silently replace the command that its own credential is allowed to execute):

   ```sh
   install -d -m 755 ~/bin
   install -m 755 deploy/auto-deploy.sh ~/bin/book-club-auto-deploy
   ```

   and its host settings in `~/.config/book-club/auto-deploy.env` ("This host's own settings").
3. **The key**: `ssh-keygen -t ed25519 -N '' -C book-club-auto-deploy -f deploy-key`; its public
   half in the deploy account's `~/.ssh/authorized_keys` as

   ```
   restrict,from="127.0.0.1,::1",command="/home/<user>/bin/book-club-auto-deploy" ssh-ed25519 <public-key> book-club-auto-deploy
   ```

   and its private half as the `production` environment's `SSH_PRIVATE_KEY` (then delete the file),
   with `SSH_HOST=127.0.0.1`, `SSH_USER` the deploy account, and `SSH_KNOWN_HOSTS` from
   `ssh-keyscan -t ed25519 127.0.0.1`.
4. **The repository**: the `production` environment (deployment branches: master only), the
   variable `BOOKCLUB_DEPLOY_ENABLED=true`, and "Require approval for all external contributors"
   for fork pull request workflows (Settings → Actions → General). For the mobile OTA, also the
   `EXPO_TOKEN` secret in `production` and the `IOS_LIVE_RUNTIME_VERSION` variable
   (`ota-update.yml` says how).

`deploy <full-sha>` rejects non-master commits and a dirty production clone, serializes host
deploys with `flock`, and skips stale runs that would undo a newer commit. It uses the existing
`deploy/.env` and the compose files its host settings name: data volumes, backups and the separately
profiled LiveKit service are preserved. It builds first, then restarts and waits for container and
public HTTPS health. Images carry `org.opencontainers.image.revision`, which must match the checked
SHA. It saves the running image before building (`bookclub:rollback-<previous commit>`), so a failed
start/health check can restore that exact image and the previous Git commit without another registry
download or build; it keeps the newest two such tags. A failed deploy still fails the workflow even
if rollback succeeds. It never resets or restores the live database; schema-changing commits must be
reviewed for backward compatibility (an image rollback cannot undo an incompatible migration).
The newest previous-image tags are retained for manual recovery (see Disk retention).

### Disk retention

A small host's root disk is usually shared with other services, and every deploy adds a ~2 GB
image. On 2026-11-02, 13 deploys in a day filled one and took the host's other services down.
`auto-deploy.sh` bounds what it leaves behind:

| Rule | Default | Override |
|------|---------|----------|
| Rollback images kept: the newest distinct images tagged `bookclub:rollback-<commit>`, by creation time, plus the running `bookclub:runtime` (a tag on the running image or on an image already kept takes no slot) | 2 | `BOOKCLUB_KEEP_ROLLBACKS` |
| Build cache trimmed to this size, oldest first | 8gb | `BOOKCLUB_BUILD_CACHE_MAX` |
| Free space Docker's filesystem needs before a build starts | 8 GB | `BOOKCLUB_MIN_FREE_GB` |

The cleanup runs before every build, after every successful deploy and after a successful
rollback (which untags the failed build). It removes only `bookclub:rollback-*` tags past the
limit, untagged images labelled `com.docker.compose.project=bookclub`, and build cache beyond
the limit. It never touches `bookclub:runtime`, a hand-made tag, volumes, or any other
project's images; the build cache is the Docker daemon's, shared by every stack, so trimming it
only makes another stack's next build colder. If the space is still under the limit after the
cleanup, it drops the whole unused build cache (the next build is cold). That holds for every
cleanup, including the one after a successful deploy, whose own build can take the host under
the floor. Before a build the deploy then checks again, and only if it is still short does it
fail, before it changes the clone, the tags or the running stack:

```
auto-deploy: only 5 GB free on /var/lib/docker, the deploy needs 8 GB (BOOKCLUB_MIN_FREE_GB); nothing was changed. ...
```

Each rollback tag is named after the revision the running image was built from (its
`org.opencontainers.image.revision` label), not the clone's HEAD, so it stays true when the
clone is moved by hand.

Free space by hand (check `docker system df` and `df -h /var/lib/docker`), then re-run the
workflow. The workflow reaches the script as an SSH forced command and passes it no environment
variables, so a limit for every deploy goes in the host's own settings
(`~/.config/book-club/auto-deploy.env`, "This host's own settings"); an environment variable
overrides it for a run by hand. To see what a cleanup would keep and remove, without changing
anything:

```sh
~/bin/book-club-auto-deploy retention
```

Check a deployed revision with:

```sh
docker inspect bookclub-app-1 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
curl -fsS https://books.example.org/healthz
```

Host rollback by hand is still possible with the preserved image tag and the previous commit; do
not use `compose down -v`.

### When the command changes

The forced command is a copy of `deploy/auto-deploy.sh` installed outside the clone, so a merged
change to the script does nothing on the host until that copy is replaced (D218). Every deploy
compares the installed copy with `deploy/auto-deploy.sh` at the commit it deploys. When they differ,
the deploy goes ahead as before and says so, with the command that installs the reviewed version,
in its output and as a warning annotation on the GitHub Actions run:

```sh
install -m 755 /opt/book-club/deploy/auto-deploy.sh ~/bin/book-club-auto-deploy   # as the deploy account, after the deploy
~/bin/book-club-auto-deploy retention                                               # says whether it is current
```

`retention` makes the same comparison, read-only, against the clone's `origin/master`.

A host that would rather not do this by hand sets `BOOKCLUB_DEPLOY_SELF_UPDATE=1` in its settings
file (`~/.config/book-club/auto-deploy.env`, which no commit can change). A deploy then installs
the deployed commit's `deploy/auto-deploy.sh` over the installed copy in one move (a new file moved
into place, so the running copy reads on undisturbed), leaves a notice on the run, and has the new
version carry out that same deploy, still holding the deploy lock. If the new version cannot be put
in place, the deploy stops before changing anything. The trade: with it on, a reviewed merge to
master changes what the deploy key runs without a second, manual step. Master's merges already
decide the image the host runs and the compose files the command starts it with, so the setting
adds no new party who can change the host; it removes the hand check in between. Off (the default),
the hand check stays, and the warning says when it is due. The first install of a version that has
this check is always by hand.
