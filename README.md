# pi-cliproxyapi-provider

Pi provider extension that discovers models from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and registers them for use in pi. It supports catalog-driven Fast and Ultra Fast modes and also ships a small TUI helper that shows elapsed runtime and a TPS summary after each agent turn.

## What it does

1. Registers a provider that always appears in `/login` (account sign-in path).
2. Interactive setup collects `baseUrl` + `apiKey` via `/login CLIProxyAPI` or `/login cliproxyapi`.
3. Fetches `{root}/v1/models?client_version=pi`.
4. Maps the CLIProxyAPI catalog into pi models, including support for faster service tiers.
5. Registers inference against `{root}/backend-api/`.
6. Provides `/fast` and `/ultrafast` to select faster service tiers for supported models.
7. Caches the model catalog in `~/.pi/agent/cliproxyapi-models.json`, refreshes it in the background on startup, and provides `/cliproxyapi-refresh` to force a refresh.
8. In interactive TUI sessions, shows footer elapsed time during runs and a TPS / token usage toast when the agent settles.
9. After compaction, closes the reused Codex WebSocket for that session so CLIProxyAPI's server-side context resets with the compacted client messages.

## Install

```bash
# from npm
pi install npm:@router-for-me/pi-cliproxyapi-provider

# from a local checkout
pi install /absolute/path/to/pi-cliproxyapi-provider

# or temporarily for one run
pi -e /absolute/path/to/pi-cliproxyapi-provider
```

## Login-style setup (recommended)

This plugin needs both **baseUrl** and **apiKey**. pi's built-in `/login` only supports multi-field prompts on the account/OAuth path, so CLIProxyAPI appears under **Sign in with an account** (not API key).

### Preferred: /login shortcuts

```text
/login CLIProxyAPI
```

or:

```text
/login cliproxyapi
```

These shortcuts jump straight into CLIProxyAPI's multi-field baseUrl + API key prompts. The provider is registered as OAuth-only, so pi does not ask you to choose between API key and account first.

### Menu path

```text
/login
```

Then choose:

1. **Sign in with an account**
   (required for multi-field baseUrl + API key prompts)
2. **CLIProxyAPI**
3. Enter:
   - base URL — preferred form is host:port, e.g. `http://127.0.0.1:8317`
   - API key

Final login validation calls `{root}/v1/models?client_version=pi` (this always bypasses the model cache and forces a fresh remote query):

- **HTTP 200** → login succeeds (empty model list is still OK) and the model cache is rewritten
- **non-200 / network error** → login fails and you are prompted to re-enter base URL + API key

On success:

- models are registered immediately in the current session (0 models is allowed)
- `baseUrl` / `apiKey` are written to `~/.pi/agent/cliproxyapi.json`
- pi also stores the returned credential in `~/.pi/agent/auth.json`

Re-run `/login CLIProxyAPI` or `/login cliproxyapi` anytime to reconfigure. The built-in `/logout` command only removes credentials saved in `auth.json`; it does not erase `cliproxyapi.json`. Remove or update that file if you also need to clear the provider configuration.

## Non-interactive configuration

You can still configure without `/login`.

### Config file

`~/.pi/agent/cliproxyapi.json`:

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "12345",
  "fast": false,
  "pause": false
}
```

Optional fields:

| Field | Default | Description |
| ------- | --------- | ------------- |
| `baseUrl` | `http://127.0.0.1:8317` | CLIProxyAPI address |
| `apiKey` | _(required unless set via /login or env)_ | Bearer token / CPA API key |
| `providerId` | `cliproxyapi` | Provider id shown in `/model` |
| `providerName` | `CLIProxyAPI` | Display name in `/login` and UI |
| `fast` | `false` | Persisted speed preference: `false` (off), `true` (Fast), or `"ultrafast"` (Ultra Fast) |
| `pause` | `false` | Persisted request-pause preference; provider requests wait until it is cleared |

### Environment overrides

| Variable | Overrides |
| ---------- | ----------- |
| `CLIPROXYAPI_BASE_URL` | `baseUrl` |
| `CLIPROXYAPI_API_KEY` | `apiKey` |
| `CLIPROXYAPI_PROVIDER_ID` | `providerId` |
| `CLIPROXYAPI_PROVIDER_NAME` | `providerName` |
| `CLIPROXYAPI_FAST` | `fast` (`true` / `false`, also accepts `1`, `0`, `yes`, `no`, `on`, `off`) |

Resolution order for connection settings:

1. Environment variables
2. `cliproxyapi.json`
3. `/login` credentials in `auth.json`
4. Default baseUrl `http://127.0.0.1:8317`

At startup, `CLIPROXYAPI_FAST` overrides the persisted speed preference: a true value selects Fast, and a false value turns both modes off. The variable does not accept `ultrafast`. If unset, the provider uses `fast` from `cliproxyapi.json`, or defaults to off.

### baseUrl normalization

Preferred form is **host:port only**:

| Input | Inference baseUrl | Models URL |
| ------- | ------------------- | ------------ |
| `http://127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | `http://127.0.0.1:8317/v1/models?client_version=pi` |
| `http://127.0.0.1:8317/backend-api` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `http://127.0.0.1:8317/v1` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | same models URL |

pi then sends inference traffic to `{inference}/codex/responses`.

## Fast and Ultra Fast modes

Both modes are **off by default**. They request faster processing for supported models and may use more credits or incur higher costs.

| Command | Model status label | Request field |
| ------- | ------------------ | ------------- |
| `/fast` | `fast` | `service_tier: "priority"` |
| `/ultrafast` | `Ultra Fast` | `service_tier: "ultrafast"` |

The modes are mutually exclusive. Run the active command again to turn it off, or run the other command to switch directly. Each change saves the global preference in `~/.pi/agent/cliproxyapi.json` and refreshes the provider's model pricing. The saved preference is restored at the next startup unless `CLIPROXYAPI_FAST` overrides it.

Both modes apply only to models whose CLIProxyAPI catalog entry has a non-empty `service_tiers` array. The provider ignores `additional_speed_tiers`. When a mode is effective, pi appends its yellow label to the bottom-right model status without a separate notification. On unsupported models, the commands still update the global preference and warn when enabling a mode, but the request and model status remain unchanged.

Both modes are independent of pi's reasoning level and use `experimental.modes.fast.cost` from `models.dev` when available. Otherwise, the registered model uses the standard price; the plugin does not guess prices from `-pro` or `-fast` model IDs.

## Pausing provider requests

Pause provider requests with:

```text
/pause
```

Use `/continue` to clear the pause:

```text
/continue
```

Both commands persist the `pause` boolean in `~/.pi/agent/cliproxyapi.json`. Before every provider request, the extension rereads this setting. When it is `true`, the request waits asynchronously and checks again every 200 ms until `/continue` sets it to `false`. A pause issued during an active run lets that run finish before Elapsed stops; a run that starts while paused excludes its waiting time from Elapsed and TPS.

## Model cache

The provider keeps a separate cache file so startup stays fast when CLIProxyAPI is slow or briefly unreachable:

`~/.pi/agent/cliproxyapi-models.json`

The cache stores only model metadata and derived endpoint URLs — the model list, Fast-capable IDs, `inferenceBaseUrl`, `modelsUrl`, and a `fetchedAt` timestamp. It **never** stores your API key or other credentials.

| Property | Value |
|----------|-------|
| Cache file | `~/.pi/agent/cliproxyapi-models.json` |
| Remote query timeout | 60 seconds |
| Scope | tied to the current `baseUrl` (a different base URL ignores the existing cache) |

### Startup / resume behavior

When the provider loads (including session resume):

1. If a cache exists for the configured `baseUrl`, its models are registered immediately. A remote query to `{root}/v1/models?client_version=pi` then runs in the background; on success, the cache is rewritten and the registered model list is refreshed. If the query fails, the existing cache remains active.
2. If no matching cache exists, the remote query runs synchronously. On success, the cache is written and the fetched models are registered. If it fails, startup logs a warning and no models are registered until the proxy responds.

Use `/cliproxyapi-refresh` to force an immediate remote refresh of the model catalog.

### Refresh commands

- `/cliproxyapi-refresh` — force an immediate remote refresh of the model catalog, rewrite the cache, and update registered models. Use this after adding or removing models on the proxy without restarting pi.
- `/login CLIProxyAPI` / `/login cliproxyapi` — re-entering credentials always forces a fresh models query and rewrites the cache.

Delete `~/.pi/agent/cliproxyapi-models.json` to clear the cache manually.

## Model mapping

From CPA catalog entry → pi model:

| CPA field | Pi field |
| ----------- | ---------- |
| `slug` | `id` |
| `display_name` | `name` |
| `context_window` | `contextWindow` |
| `input_modalities` | `input` (`text` / `image`) |
| `supported_reasoning_levels[].effort` | `thinkingLevelMap` + `reasoning` |
| `supports_reasoning_effort_updates` | `compat.supportsMidConvoEffort` |
| `visibility: "hide"` | skipped |

Unsupported pi thinking levels are set to `null` so they are hidden in the UI. When available, prices are matched against canonical model entries in `models.dev`; `cost.tiers[].tier.size` becomes pi's `inputTokensAbove`, including thresholds such as `272000`. The legacy `context_over_200k` field is used only when no explicit tiers are present. Ambiguous reseller prices are not selected arbitrarily and fall back to zero. These are catalog/list prices, not a guarantee of CPA's own markup or billing.

## GPT Responses prompt caching

For `gpt-` model IDs (ignoring case and surrounding whitespace), the provider sends the base prompt as the first `developer` input message instead of top-level `instructions`. Nonblank text is kept verbatim; blank text defaults to `You are a helpful assistant.` Existing input items stay in order, tools and `prompt_cache_key` are unchanged, and other models keep their existing request shape. This applies to HTTP and WebSocket requests, including Pi background streams that use this provider. A changed developer prefix or model sends the full input instead of a WebSocket continuation delta.

## Cache-preserving thinking level changes

Models whose catalog entry sets `supports_reasoning_effort_updates` (GPT-6 on CLIProxyAPI) get pi's cache-preserving mid-session thinking level changes, matching the behavior pi >=1.3.0 ships for the OpenAI provider, with placement following the OpenAI documentation: the effort of the first turn becomes the fixed request-level `reasoning.effort`, and each later change is carried by a `configuration_update` input item placed immediately before the user message it applies to, so switching levels mid-session keeps the prompt prefix — and the upstream prompt cache — intact instead of rewriting it. WebSocket `previous_response_id` continuation also survives level changes. Histories lacking initial recorded levels (for example, sessions started before this support landed) may still need one full-context request while the baseline is being established. The behavior requires a pi >=1.3.0 host (its shared Responses converter); on older hosts the plugin detects the missing support and falls back to the classic request-level effort.

The raw `models.dev` response is cached for 24 hours at `~/.pi/agent/tmp/models-dev-cache.json`. A fresh cache avoids the network request; an expired cache is refreshed with a three-second timeout, and stale data is retained if refresh fails. If neither the network nor a previous cache is available, pricing safely falls back to zero. A small explicit alias table covers known CLIProxyAPI variants such as `gemini-pro-agent` → `gemini-3.1-pro-preview`; unknown variants are not guessed.

## Migration from static models.json

If you previously maintained a static provider such as `cpa-responses` in `~/.pi/agent/models.json`:

1. Install this package and run `/login CLIProxyAPI` or `/login cliproxyapi` (or set `cliproxyapi.json`).
2. Point `defaultProvider` / `enabledModels` at `cliproxyapi/<model-id>` (or set `providerId` to `cpa-responses` for a drop-in id).
3. Remove the hand-maintained models array once the dynamic list looks correct.

## Elapsed time and TPS (TUI)

The package also registers `extensions/tps.ts`, which only activates for the primary interactive TUI session (`ctx.hasUI && ctx.mode === "tui"`):

- While the agent is running, the footer shows `Elapsed …` (updates every second).
- When the agent settles, the footer keeps the final elapsed time and a notification reports approximate TPS plus token usage (`out` / `in` / cache r/w / total).
- Subagent and print-mode sessions do not own the timer, clear the parent footer, or emit TPS toasts.

Disable just this helper via `pi config` if you only want the CLIProxyAPI provider.

## Failure behavior

- CLIProxyAPI `closed network connection` responses are normalized as transient network errors so pi's agent-level retry policy reconnects and restarts the interrupted assistant turn. Completed conversation and tool results remain available; token streaming does not resume from the exact interruption point.
- Before setup / without credentials: provider still appears in `/login`; no models are listed yet.
- After successful `/login`: models are registered; credentials are stored in `auth.json` and mirrored to `cliproxyapi.json`.
- The built-in `/logout` command removes only the matching `auth.json` credential; environment variables and `cliproxyapi.json` are unchanged.
- If a models request returns **HTTP 401** or CPA is unreachable during startup, an existing matching cache remains in use while the background refresh fails. Only when no cache is available is a warning logged; reconfigure via `/login CLIProxyAPI` or fix config/env.
- Login final step validates credentials by requesting models:
  - HTTP 200 (including empty catalog) → credentials are persisted
  - non-200 / network / invalid baseUrl → nothing is persisted; re-enter baseUrl + API key
- If CPA returns HTTP 200 with zero usable models: login still succeeds; re-run `/login CLIProxyAPI` later after models become available.
- If the selected model does not provide a non-empty `service_tiers` array: the request is left unchanged; `/fast` and `/ultrafast` still update the global preference and warn when enabling a mode.
- After `/compact`, threshold compaction, or overflow recovery, the provider closes the reused Codex WebSocket for the current session. CLIProxyAPI binds server-side context to the connection, so a reused socket would keep reporting a near-full `cacheRead` and retrigger proactive compaction even though the client context is now small. SSE is unaffected because it bills from the request body.
