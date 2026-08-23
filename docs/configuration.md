# Configuration

> **Design document.** The server does not exist yet — no setting here does
> anything today. See the [README](../README.md) for status.

Every setting can be left alone. The defaults are chosen to be safe and quiet:
read-only, conservative with your API quota, no surprises.

---

## Where settings come from

Three sources, highest priority first:

1. **Environment variables** — `FEEDLY_MCP_BUDGET_DAILY_CALLS=150`
2. **Config file** — `~/.config/feedly-mcp/config.toml`
3. **Built-in defaults**

An environment variable always wins. This matters if you installed the
`.mcpb` bundle: the extension settings form passes values in as environment
variables, so they override anything in your config file. Editing the file and
seeing no effect usually means the bundle is setting the same value.

### Config file location

| | |
|---|---|
| Default | `~/.config/feedly-mcp/config.toml` |
| Respects | `$XDG_CONFIG_HOME` if set |
| Override | `--config /path/to/file.toml` |

The file is optional. If it does not exist, defaults apply.

### Environment variable names

`FEEDLY_MCP_` + section + `_` + key, uppercased.

```
[budget] daily_calls    →  FEEDLY_MCP_BUDGET_DAILY_CALLS
[scope]  default_folder →  FEEDLY_MCP_SCOPE_DEFAULT_FOLDER
[writes] enabled        →  FEEDLY_MCP_WRITES_ENABLED
```

List values are comma-separated:

```bash
FEEDLY_MCP_SCOPE_INCLUDE_FOLDERS="AI,Longform,Norsk presse"
```

The token is the exception — it is plain `FEEDLY_TOKEN`, with no prefix.

---

## `[feedly]`

### `token_file`

**Type:** path · **Default:** `~/.config/feedly-mcp/token`

A file containing nothing but your token. Only read if `FEEDLY_TOKEN` is unset.

The file must have permissions `0600` (readable only by you). The server refuses
to read it otherwise, and tells you how to fix it:

```bash
chmod 600 ~/.config/feedly-mcp/token
```

**Never put your token in `config.toml`.** Config files get copied into dotfile
repos, pasted into issues, and synced to places you did not intend. There is no
`token` setting, deliberately.

### `api_base`

**Type:** URL · **Default:** `https://api.feedly.com`

Only change this if you are on an Enterprise tenant with a different host.

---

## `[scope]`

Controls which folders exist as far as the agent is concerned.

This is enforced, not cosmetic. Out-of-scope folders are hidden from
`list_folders`, *and* `get_articles` rejects them even if the agent supplies a
raw folder ID it learned somewhere else.

### `include_folders`

**Type:** list of strings · **Default:** `[]` (all folders)

An allowlist. Accepts folder labels or IDs; labels are easier to read and are
matched case-insensitively.

```toml
include_folders = ["AI", "Longform"]
```

Once non-empty, everything not listed is invisible.

### `exclude_folders`

**Type:** list of strings · **Default:** `[]`

A denylist, applied after `include_folders`. Useful when you want almost
everything:

```toml
exclude_folders = ["Work - internal", "Private"]
```

### `default_folder`

**Type:** string · **Default:** unset

Used when the agent asks for articles without naming a folder. Without it, an
unqualified request covers everything in scope, which is usually more than you
wanted.

If all your feeds also live in one top-level folder, name that one here. It is
both the most useful default and the cheapest to fetch.

---

## `[defaults]`

Fallback values for tool parameters the agent leaves out. The agent can always
override these per call; these just set the starting point.

| Setting | Type | Default | Notes |
|---|---|---|---|
| `hours` | integer | `8` | How far back `get_articles` looks. **Max 744** (31 days) — Feedly silently returns nothing beyond that. |
| `limit` | integer | `100` | Max articles per call. Higher means more of your context window spent. |
| `unread_only` | bool | `true` | Whether `get_articles` skips what you have already read. |
| `summary_chars` | integer | `400` | Summaries are trimmed to this. Raising it well past ~800 makes large responses unwieldy. |
| `full_text` | bool | `false` | Adds a `summary_full` field with a longer extract. Off for a reason — a single call can otherwise return tens of thousands of words. |

---

## `[budget]`

Your defence against an over-eager agent. See
[the quota section in the README](../README.md#your-api-quota--please-read-this)
for why this matters.

| Setting | Type | Default | Notes |
|---|---|---|---|
| `daily_calls` | integer | `40` | Ceiling on calls per day, out of the 50 a developer token appears to get. The remainder is left for your own browsing. |
| `session_calls` | integer | `10` | Ceiling per server session, so one runaway conversation cannot spend the whole day. |
| `warn_below` | integer | `10` | When fewer calls than this remain, every response carries a visible warning. |

> **The real limit is lower than Feedly documents.** A developer token on a paid
> Pro Plus account reports `X-Ratelimit-Limit: 50` per day — not the 250/500 the
> documentation describes. The defaults above are built for 50. Check your own
> ceiling with `doctor`, and raise these only if it reports something higher.

Raising `daily_calls` above your actual limit does nothing useful — you will just
hit Feedly's 429 instead of a clean local error.

Counters are stored in the cache directory and reset on Feedly's daily schedule,
read from the `X-Ratelimit-Reset` header.

---

## `[cache]`

Caching exists to protect your quota, not to build an archive. Everything here
expires on a timer, and none of it is searchable.

| Setting | Type | Default | What it covers |
|---|---|---|---|
| `metadata_ttl` | duration | `"24h"` | Folder and subscription lists. These almost never change, and they are needed by nearly every call. |
| `articles_ttl` | duration | `"15m"` | Identical article requests. Ask twice about the same folder in one conversation and it costs one call. |
| `dir` | path | `~/.cache/feedly-mcp` | Respects `$XDG_CACHE_HOME`. |

Durations accept `s`, `m`, `h`, `d` — `"90s"`, `"6h"`, `"1d"`.

Setting `metadata_ttl = "0s"` disables metadata caching and roughly doubles your
call count. Against a 50-call daily budget, there is no good reason.

The 24-hour default means a newly added subscription can take a day to appear.
When that bothers you, clear the cache instead of lowering the TTL:

```bash
npx -y feedly-mcp doctor --refresh
```

The cache is keyed by the account ID from `/v3/profile`, so switching tokens
cannot serve you another account's data. To clear it:

```bash
rm -rf ~/.cache/feedly-mcp
```

---

## `[writes]`

Marking articles read in Feedly is **permanent**. There is no undo, and recovery
means emailing Feedly support. Both switches are off by default.

### `enabled`

**Type:** bool · **Default:** `false`

Allows `mark_read` with an explicit list of article IDs. The agent must name
exactly what it is marking.

### `bulk_mark_read`

**Type:** bool · **Default:** `false`

Additionally allows `mark_read` on a whole folder — potentially thousands of
articles from one tool call. Requires `enabled = true` as well.

Two separate switches because the two operations differ enormously in what they
can cost you if the agent misunderstands.

```toml
[writes]
enabled        = true
bulk_mark_read = true   # think about this one
```

There is no unsubscribe setting. It is not implemented at any configuration
level — deleting your subscriptions is not something an agent should be able to
do. Use Feedly.

---

## Complete example

Every setting at its default, for copying and editing:

```toml
[feedly]
token_file = "~/.config/feedly-mcp/token"
api_base   = "https://api.feedly.com"

[scope]
include_folders = []
exclude_folders = []
# default_folder = "AI"

[defaults]
hours         = 8
limit         = 100
unread_only   = true
summary_chars = 400
full_text     = false

[budget]
daily_calls   = 40
session_calls = 10
warn_below    = 10

[cache]
metadata_ttl = "24h"
articles_ttl = "15m"

[writes]
enabled        = false
bulk_mark_read = false
```

## Checking what is actually in effect

```bash
npx -y feedly-mcp doctor
```

`doctor` prints the resolved configuration, says which source each value came
from, and warns about folders in `scope` that do not exist in your account. It
never prints your token.
