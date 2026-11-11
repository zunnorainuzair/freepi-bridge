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

Or install it once for the short command:

```bash
npm install -g freepi-bridge
freep               # starts the server (also installed as `fpb`)
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
freep               # terminal 1 — starts the server and prints the provider details
freep dsh --write   # terminal 2 — patch ~/.dsh/profiles/desktop/cordis.patch.yml
```

Restart dsh. `freepi` appears as a provider and the chosen model becomes the default.

`freep` with no arguments starts the server and prints exactly what dsh needs:

```
  Provider details for dsh (copy these into cordis.patch.yml):
    provider ID   freepi
    base URL      http://127.0.0.1:8791/v1
    API key       freepi-bridge  (any non-empty value works; the bridge holds your free-pi sign-in)
    api           openai-completions
    models        /v1/models  (GET, OpenAI format — required by dsh)
    default model deepseek-v4.1-flash
```

| dsh field | Value |
|---|---|
| provider ID | `freepi` (lower-case) |
| base URL | `http://127.0.0.1:8791/v1` |
| API key | `freepi-bridge` — any non-empty string; the real free-pi token never leaves the bridge |
| api | `openai-completions` |
| models | served at `GET /v1/models` in OpenAI format |

The model list dsh shows comes from the patch's `models:` array (dsh reads it from
there, not from `/v1/models`), but `/v1/models` is served too and is strictly
OpenAI-shaped — `{object: "list", data: [{id, object: "model", created, owned_by}]}`.

## Context window and reasoning (measured, not copied)

Both values in the generated patch were probed against the live backend, because
the free-pi CLI's own constants do not survive contact with it:

| Setting | Value | Why |
|---|---|---|
| `contextWindow` | **122880** | Measured: a 123,787-token prompt was accepted, 125,000 was refused with `HTTP 413 "This conversation is too long"`. The CLI advertises 200000, which the backend does **not** honour — copying it makes dsh grow a conversation until it dies mid-turn. |
| `maxTokens` | **8192** | Matches free-pi's `MAX_OUTPUT_TOKENS`; the backend will not emit more. |

**Reasoning has no levels here.** free-pi's CLI never sends `reasoning_effort`
(zero occurrences in its bundle). Reasoning is simply always on and every
response carries `reasoning_content`. The backend also ignores the parameter —
`reasoning_tokens` stayed at 11-18 whether the level was `minimal`, `low`,
`medium`, `high` or `xhigh`.

Declaring `reasoningEfforts` in the dsh patch is therefore both pointless and
harmful: pi-ai's `openai-completions` adapter turns a declared level into
`reasoning_effort`, or into `thinking: {type: "disabled"}` /
`enable_thinking: false` for the zai and qwen formats, and with reasoning
suppressed DeepSeek returns empty content plus malformed `tool_calls`.

So the bridge handles it for you:

- the emitted patch **omits `reasoningEfforts`**, which dsh treats as "keep the
  installed catalog's capability";
- the server **strips** `reasoning`, `reasoning_effort`, `reasoningEffort`,
  `thinking`, `thinking_budget`, `thinkingBudget`, `enable_thinking`,
  `chat_template_kwargs` and `chat_template_args` from every request, so a
  client that sends them anyway still gets working tool calls. It forwards
  exactly what free-pi's own CLI would send.

Run the server with `--log` to see it: `stripped reasoning knob(s):
reasoning_effort, thinking, enable_thinking`.

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
freep                          start the server (same as `serve`)
freep serve                    start the server explicitly
freep models                   list the models free-pi offers right now
freep dsh [--write]            print (or apply) the dsh profile patch
freep env                      print OPENAI_* values
freep status                   account, allowance, token expiry
freep takeover                 release this account's other free-pi sessions
freep doctor                   diagnose sign-in, token, upstream
freep login                    run the free-pi CLI to sign in
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

## Checking for drift

dsh rewrites `cordis.patch.yml` from its own internal config, so it can revert
the provider block behind your back. That revert is invisible until a turn fails
with `413 context_too_long` (a profile claiming 200000 makes dsh let a
conversation grow past the ~124k the backend accepts).

```bash
freep dsh --check
```

```
profile: ~/.dsh/profiles/desktop/cordis.patch.yml
  DRIFT contextWindow 200000 exceeds the measured backend limit (expected <= 122880)
  DRIFT maxTokens 32768 exceeds free-pi's 8192
  DRIFT apiKeyEnv: FREEPI_API_KEY is set — the bridge is keyless, so remove it
  DRIFT reasoningEfforts is set — breaks tool calls
```

Exit code is 1 when anything drifted. Fix by quitting dsh, running
`freep dsh --write`, and starting dsh again.

If the *session* already grew past the limit, the profile fix will not shrink
it — start a new chat (`/new`) or compact.
