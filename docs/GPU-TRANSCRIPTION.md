# Transcribing on a GPU box, with this host as the fallback

The deploy image's recogniser (base.en, CPU int8, 2 threads; docs/RUNBOOK.md, "Reading along")
takes about 22 minutes for a 3-hour audiobook. A GPU runs small.en, the closer model, in under two
minutes for the same book (docs/ALIGNMENT.md, measured on an RTX PRO 6000: 107 s for Alice, 97.2 %
of the words matched, 0.12 s median timing error). The GPU box is not always running, so the server
hands each run to it when it answers and transcribes on this host when it does not.

## How it fits together

```
app container                       Book Club host            relay host (optional)         GPU box
TRANSCRIBE_COMMAND =                172.17.0.1:8790  <--ssh -R-- 127.0.0.1:8791 --ssh -L-->  127.0.0.1:8790
  transcribe_remote.py LOCAL...       (bc-gpu-relay,                                        transcribe_service.py
  --out OUT TRACKS...                  forward only)                                         -> transcribe.py --device cuda
```

- `tools/align/transcribe_remote.py` stands in front of the local recogniser in the image's
  `TRANSCRIBE_COMMAND`. Its arguments are the local command line, whole (with the server's
  `--out <json> <tracks...>` at the end). With `TRANSCRIBE_REMOTE_URL` unset it simply becomes that
  command (exec), so a deploy without a GPU behaves as before. With it set it checks
  `GET /healthz` (5 s), sends the tracks, polls the job, and checks the transcript it gets back:
  format `bookclub-transcript/1`, one track per file, each track's SHA-256 the file's own. It then
  writes it to `--out` with each track named by the local file, exactly as transcribe.py would. On
  any failure (unreachable, wrong token, busy, the recogniser failing, a bad transcript, or no
  answer for 90 s midway, as when the box stops under it) it becomes the local command instead,
  from the start. SIGTERM from the server cancels the remote job (`DELETE`) and exits 143; once it
  has fallen back, the local recogniser is the same process and gets the server's signals itself.
  Voice notes (D-media) use the same command and the same path.
- `tools/align/transcribe_service.py` runs on the GPU box, on its loopback only. It is stdlib
  HTTP with a bearer token: `POST /jobs`, `PUT /jobs/<id>/tracks/<i>` (checked against the size
  and SHA-256 given), then it runs transcribe.py with `--out` and the tracks under their own base
  names, so the output is transcribe.py's. One job at a time (a second gets 503 and runs locally);
  a job nobody asks about for 3 minutes is stopped and removed. While a job exists it touches
  `--busy-file` every 15 s.
- The recogniser listens on the box's loopback only, and the Book Club host reaches it through an
  SSH reverse forward on its docker bridge (`172.17.0.1:8790`, `host.docker.internal` in the app
  container). If the box can SSH to the Book Club host, one reverse forward from the box is enough.
  If neither end can dial the other (a box whose address changes at every start, a host that takes
  SSH only from a private network), a relay host that reaches both keeps two forwards instead: a
  local forward to the box (looking its address up each time it starts) and a reverse forward on
  the Book Club host's docker bridge (below). When the box is stopped, the host-side port still
  listens but every connection is refused at once, so the health check fails in milliseconds and
  the run is local.

Settings (`deploy/.env`): `BOOKCLUB_TRANSCRIBE_REMOTE_URL=http://host.docker.internal:8790` and
`BOOKCLUB_TRANSCRIBE_REMOTE_TOKEN=<the box's token>`. Unset, nothing changes.

## Setting it up

Secrets stay out of git: the token lives in the box's `/etc/bookclub-transcriber/token`, on
whichever machine keeps the tunnel (only as an SSH key; the token is not needed there), and in the
Book Club host's `deploy/.env`.

1. **GPU box.** The venv of docs/ALIGNMENT.md in `~/align/venv`, small.en already in `~/align/hf`
   (the service runs `--offline`). Copy `tools/align/progress.py`, `transcribe.py` and
   `transcribe_service.py` to `/opt/bookclub-transcriber/`, the token to
   `/etc/bookclub-transcriber/token` (root:ubuntu 0640), and install
   `deploy/gpu/bookclub-transcriber.service` (enabled, so it starts with the box). If the box shuts
   itself down when idle, have that check count a fresh busy file as work:
   `[ -n "$(find /run/bookclub-transcriber/busy -mmin -2 2>/dev/null)" ] && busy=1`.
2. **Book Club host.** A system account `bc-gpu-relay` (no home, nologin), its one key in a
   root-owned `/etc/bookclub-gpu-relay/authorized_keys` with
   `restrict,port-forwarding,permitlisten="172.17.0.1:8790",command="/usr/sbin/nologin"`, and an
   sshd `Match User bc-gpu-relay` block (`/etc/ssh/sshd_config.d/61-bookclub-gpu-relay.conf`):
   `AuthorizedKeysFile /etc/bookclub-gpu-relay/authorized_keys`, `AllowTcpForwarding remote`,
   `PermitListen 172.17.0.1:8790`, `GatewayPorts clientspecified`, `PermitOpen none`,
   `ForceCommand /usr/sbin/nologin`, no TTY. Let the app's network reach it through the firewall,
   e.g. `ufw allow proto tcp from <subnet of bookclub_default> to 172.17.0.1 port 8790`
   (`docker network inspect bookclub_default`; recreate the rule if that network is recreated with
   another subnet).
3. **The tunnel**, kept up by a systemd unit with `Restart=always` on whichever machine dials:
   - from the GPU box itself, when it can reach the Book Club host:
     `ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -i <key> -R 172.17.0.1:8790:127.0.0.1:8790 bc-gpu-relay@<book-club-host>`;
   - or from a relay host that reaches both, as two units: `ssh -N -o ExitOnForwardFailure=yes -L
     127.0.0.1:8791:127.0.0.1:8790 ubuntu@<gpu-box>` (look the box's current address up first if
     it changes at each start), and `ssh -N -o ExitOnForwardFailure=yes -i <key> -R
     172.17.0.1:8790:127.0.0.1:8791 bc-gpu-relay@<book-club-host>`.
4. Set the two `deploy/.env` lines and recreate the app container (`up -d --no-build`).

## Live progress

While a run is in flight the recogniser reports stage, tracks done, audio ms done and (when
measured) a realtime factor. The server exposes that on each audiobook edition as
`transcription` (see `packages/shared` `TranscriptionStatus`); the book page polls every 2 s
and shows a progress bar with an ETA.

- Local `transcribe.py` and the remote wrapper both write
  `TRANSCRIBE_PROGRESS_FILE` (JSON, format `bookclub-transcribe-progress/1`) and also emit a
  `PROGRESS {…}` line on stderr. Either path is enough; the server prefers the file and falls
  back to the last stderr line.
- The GPU service adds an optional `progressDetail` object on `GET /jobs/<id>` with the same
  fields. Older boxes without that field still work: the wrapper reports `transcribing_gpu`
  with track counts only until the job finishes (or falls back to CPU).
- Progress never breaks a run. A missing or corrupt progress file, a failed write, or an
  unreachable progress endpoint is ignored; transcription continues.

### Redeploying the GPU box for richer progress

The currently deployed service (without `progressDetail`) is unaffected by an app-only deploy: it never imports `progress.py`. A new `transcribe.py` on the box without `progress.py` beside it still runs (the progress import is optional); copy all three files together so the recogniser can report audio ms.

Copy these three files to `/opt/bookclub-transcriber/` and restart the unit:

```sh
scp tools/align/progress.py tools/align/transcribe.py tools/align/transcribe_service.py \
  ubuntu@<box>:/opt/bookclub-transcriber/
ssh ubuntu@<box> 'sudo systemctl restart bookclub-transcriber'
```

Until that redeploy, the site still gets stage + ETA (from the wrapper's own uploads / poll loop
and the fallback RTF); per-track audio ms and measured RTF from the GPU recogniser only appear
after the new service is live.

## Checking it

- From the container: `docker exec bookclub-app-1 sh -c 'env | grep ^TRANSCRIBE_'` shows the
  wrapper in `TRANSCRIBE_COMMAND` and the URL.
- A run's lines are in `journalctl -u bookclub-transcriber` on the box (`job ...: transcribing`,
  each track's word count), and in the transcript's `model` (`small.en` from the GPU, `base.en`
  from this host). A run that fell back says why in the app's own stderr capture (`transcribing
  locally`) and runs `transcribe.py` on the host (`ps -eo pid,etime,args | grep transcribe.py`).
- Tests: `python3 -I -m unittest discover -s tools/align -p 'test_*.py'` runs the service and
  wrapper end to end with a stand-in recogniser: remote, no URL, unreachable, wrong token, remote
  failure, wrong SHA-256, the box lost midway, and SIGTERM.

## Risks

- A spot instance can be reclaimed mid-run: that costs at most 90 s before the local run starts
  from the beginning; the server's time limit (twice the audio, at least an hour) covers both.
- The token travels in clear on the Book Club host's docker bridge (the hops between hosts are
  SSH). Any container on `bookclub_default` can reach the port; the token gates it.
