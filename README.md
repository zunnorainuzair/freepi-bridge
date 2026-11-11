# freepi-bridge

An OpenAI-compatible local API for **[free-pi](https://freepi.ai)**, so you can use
free-pi's models in **DeepSeek Harness (dsh)** — or any other OpenAI client — without
handling an API key.

It is a port of [`deepseek-bridge`](https://github.com/sarimmohib/deepseek-bridge) to the
current free-pi CLI. The reference bridge had to reimplement DeepSeek's web protocol
(cookies, PoW, SSE translation, emulated tool calls) because chat.deepseek.com has no API.
free-pi already exposes a real OpenAI-compatible endpoint, so this port is much smaller:
it forwards requests, injects the sign-in token your free-pi CLI already stored, and
emits a ready-to-paste dsh profile patch.

```
dsh ──▶ freepi-bridge (127.0.0.1:8791) ──▶ api.freepi.ai
              ▲
              └── reuses ~/.free-pi/agent/credentials.json
```

## Why a bridge at all

free-pi's backend is OpenAI-shaped but not directly usable by a harness:

| Upstream behaviour | What the bridge does |
|---|---|
| Auth is a short-lived GitHub JWT in `~/.free-pi/agent/credentials.json` | Reads it, refreshes it per request, keeps clients keyless |
| Allows **one in-flight request per account** (`429 concurrent`) | Serialises requests in a FIFO queue |
| Allows **4 concurrent sessions per account**, keyed by `x-session-id` | Claims exactly one session id for all traffic, so it can never lock you out |
| No public `/v1/models` | Builds the catalog from `/client-version` (the CLI's own source) |
| Requests must carry `x-client-version` | Sends the version the backend currently expects |
| Errors are free-pi-specific (`daily_cap`, `concurrent_session`, …) | Surfaces them as readable OpenAI-shaped errors |

## Install

Requires Node 18+ and a free-pi sign-in.

```bash
npx freepi-bridge doctor
```

Or install it once and use the short alias:

```bash
npm install -g freepi-bridge
fpb doctor          # `freepi-bridge` and `fpb` are the same command
```

From source:

```bash
git clone https://github.com/zunnorainuzair/freepi-bridge.git
cd freepi-bridge
npm install            # no runtime dependencies
node bin/freepi-bridge.js doctor
```

Sign in once with the free-pi CLI if you have not already:

```bash
npx free-pi-cli@latest      # accept terms, sign in with GitHub, then quit
```

`freepi-bridge doctor` tells you if anything is missing.

## Use it from dsh

Two commands:

```bash
npx freepi-bridge serve          # terminal 1 — leave it running
npx freepi-bridge dsh --write    # terminal 2 — patch ~/.dsh/profiles/desktop/cordis.patch.yml
```

(With a global install, use `freepi-bridge` or `fpb` instead of `npx freepi-bridge`.)

Restart dsh. `freepi` appears as a provider and the chosen model becomes the default.

`--write` backs the file up first and replaces only the `llm-pi-ai` and
`agent-default-model` entries, so your other patches (permissions, UI, bundles) are
untouched, and re-running it does not duplicate the block.

To see the block instead of writing it:

```bash
freepi-bridge dsh --model deepseek-v4-flash
```

Useful flags: `--all` includes the Defense models, `--profile <name>` targets a different
dsh profile, `--port N` matches a bridge on another port.

## Use it from anything else

```bash
freepi-bridge env
```

```json
{
  "OPENAI_BASE_URL": "http://127.0.0.1:8791/v1",
  "OPENAI_API_KEY": "not-needed",
  "OPENAI_MODEL": "deepseek-v4-flash"
}
```

```bash
curl http://127.0.0.1:8791/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hello"}]}'
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/models` | Model catalog (live from free-pi) |
| `POST` | `/v1/chat/completions` | Chat, streaming or not, with tool calls |
| `GET` | `/v1/usage` | Signed-in account and remaining allowance |
| `GET` | `/health` | Liveness, queue depth, request counters |

Streaming (`"stream": true`) returns standard OpenAI SSE. Native `tool_calls` work in
both modes, and `reasoning_content` is passed through untouched.

## Commands

```
freepi-bridge serve            start the server
freepi-bridge models           list the models free-pi offers right now
freepi-bridge dsh [--write]    print (or apply) the dsh profile patch
freepi-bridge env              print OPENAI_* values
freepi-bridge status           account, allowance, token expiry
freepi-bridge takeover         release this account's other free-pi sessions
freepi-bridge doctor           diagnose sign-in, token, upstream
freepi-bridge login            run the free-pi CLI to sign in
```

## Models

The list changes; ask the bridge rather than trusting this file:

```bash
freepi-bridge models
```

Names carry free-pi's own labels, including a usage multiplier (`~18x usage`). Higher
multipliers drain the daily allowance faster. Models marked `unavailable` cannot be used.

## Sessions and concurrency

free-pi permits **one request at a time** and **four sessions** per account. The bridge
therefore:

- queues requests instead of firing them in parallel (`FPB_MAX_UPSTREAM`, default 1);
- uses a single stable `x-session-id` for every conversation, so the bridge occupies one
  session slot no matter how many chats or dsh windows you open.

If another tool holds your slots, you get a clear `409` message. `freepi-bridge takeover`
(or `FPB_TAKEOVER=1` to do it automatically) calls `/session/reset` to free them — note it
also frees sessions held by a running free-pi CLI.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FPB_PORT` | `8791` | Listen port |
| `FPB_HOST` | `127.0.0.1` | Bind address (loopback only by default) |
| `FPB_MAX_UPSTREAM` | `1` | Concurrent upstream requests |
| `FPB_API_KEY` | *(unset)* | If set, clients must send this as `Authorization: Bearer …` |
| `FPB_TAKEOVER` | `0` | Auto-reset other sessions on `409` |
| `FPB_SESSION_ID` | derived | Pin the upstream session id |
| `FPB_LOG` | `0` | Log each request |
| `FPB_QUEUE_TIMEOUT_MS` | `180000` | Max queue wait |
| `FPB_REQUEST_TIMEOUT_MS` | `600000` | Max upstream call time |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | Upstream backend |
| `FREEPI_AGENT_DIR` | `~/.free-pi/agent` | Where the sign-in token lives |

## Tests

```bash
npm test
```

## Limitations

- **Text only.** The bridge advertises `input: [text]` for dsh. Image support depends on
  what the free-pi route accepts, and was not exercised here.
- **One account.** Unlike the reference bridge there is no account pool or rotation; it
  uses the single free-pi sign-in on this machine.
- **Personal use.** The token is your GitHub-authenticated free-pi account. Sharing a
  bridge instance shares your allowance.

## Credits

Design and CLI shape follow `deepseek-bridge` by sarimmohib (Unlicense). This port targets
the free-pi CLI's real endpoint, so it is a thin proxy rather than a protocol
reimplementation.
