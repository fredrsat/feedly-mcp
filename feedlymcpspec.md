# Feedly MCP connector — spec

An open MCP server that gives an agent read access to *the user's own* Feedly
subscriptions. Distributed from git. Every user installs and runs it
themselves, with their own token. No hosting, no middleman.

The API observations under "Verified" were tested against the live API on
2026-08-21. The document was rewritten on 2026-08-21 after the distribution
model was settled. Synced with the documentation on 2026-08-23.

This is the design document — the rationale, and what is deliberately left out.
User-facing documentation lives in `README.md`, `docs/configuration.md` and
`docs/tools.md`. If you change return shapes or config keys here, they must
follow.

---

## 1. Purpose

An agent should be able to answer "what's new in my feeds" without remote
controlling a browser. Reading is the primary goal. Writing (marking as read)
is secondary and must be off by default.

**The connector is a translator, not an application.** It receives a tool call,
calls Feedly, cleans up the answer and returns it. It does not accumulate.

This boundary decides much of what follows, so it is worth stating precisely:

> Cache is not archive. Remembering an answer for minutes or hours to avoid
> asking the same question again is translator work. Storing articles over time
> to be able to answer *new* questions is an application.

**Not in scope:** daily digests, ranking over time, "what matters today",
notifications, OPML import/export, Boards, Notes/Highlights, Leo rules.

Everything above the line is built in the layer on top of the connector — a
Claude Project with instructions, a skill, a scheduled job. Not here. That is
also what makes the project small enough to finish.

---

## 2. Distribution model

Three layers. Build them in this order.

### 2.1 stdio server via package registry (the floor — must work)

Published to npm (or PyPI). The user pastes a block into their MCP
configuration and does not need to clone or build anything:

```json
{
  "mcpServers": {
    "feedly": {
      "command": "npx",
      "args": ["-y", "feedly-mcp"],
      "env": { "FEEDLY_TOKEN": "..." }
    }
  }
}
```

In Claude Code: `claude mcp add`.

### 2.2 MCP Bundle — one-click install in Claude Desktop

A single file (`.mcpb`; was called `.dxt` when the format launched — verify the
current file extension and CLI name before publishing, this has been renamed
once) containing the server, its dependencies and a manifest.

The manifest declares a **settings form** that Claude Desktop renders for the
user. Fields marked as sensitive are stored in the operating system's keychain,
not in plain text. The values are passed to the server as environment
variables.

This is the main reason for the requirement in §4.1: configuration must be
settable from environment variables, otherwise it cannot be bundled.

### 2.3 The MCP registry

So that people can find it. Discovery, not installation. Comes last.

### Language choice

**TypeScript is recommended**, for one reason: packing Python dependencies into
a bundle that must work on an arbitrary machine is noticeably messier than
packing `node_modules`. If you drop §2.2 and only distribute via `uvx`, Python
is just as good.

---

## 3. Authentication

`Authorization: Bearer <token>` against `https://api.feedly.com`.

Every user uses their own token against their own account. The server is never
an authorization server, brokers nothing, and stores nobody else's credentials.

### Verified

- Cookie auth alone yields **401** — `Bearer` is required even from a logged-in feedly.com tab.
- CORS: preflight from `feedly.com` to `api.feedly.com` returns **204**.

### Open question — who can obtain a token at all

The documentation contradicts itself. This no longer blocks *building*, but it
decides how many people can use the result:

- **developer.feedly.com** (the old Cloud API): developer token via
  `feedly.com/v3/auth/dev`, valid for 30 days, stated to work on a free
  account. Pro/Team can renew with a refresh token.
- **developers.feedly.com** (the newer Enterprise docs): "Self service API
  tokens are only available to Enterprise clients", via `feedly.com/i/team/api`.

Test `feedly.com/v3/auth/dev` with a free account before publishing. The answer
determines what the README should promise.

### Requirements

- The token is read **only** from the environment variable `FEEDLY_TOKEN` or
  from a file with 0600 permissions. Never from the config file.
- The token must never be returned in tool responses, logs or error messages.
- On 401: a clear "token expired" error with a renewal link and the name of the
  environment variable. Not a stack trace.

### Token lifetime is a UX problem, not a technical one

30 days on a free account is the one thing you cannot fix for your users. Say
it plainly in the README, and make the 401 message good enough that people know
what to do without opening an issue. Otherwise you get the same issue every
month.

---

## 4. Configuration

### 4.1 Sources and precedence

**Environment variable → config file → default.**

Environment variables must cover *all* settings, not just the token — the
bundle in §2.2 has no other way in. Naming convention:
`FEEDLY_MCP_<SECTION>_<KEY>`, e.g. `FEEDLY_MCP_BUDGET_DAILY_CALLS`.

Config file: `~/.config/feedly-mcp/config.toml`, overridable with `--config`.

### 4.2 Schema

```toml
[feedly]
# the token NEVER goes here. either FEEDLY_TOKEN as an environment variable,
# or a file with 0600 permissions:
token_file = "~/.config/feedly-mcp/token"
api_base   = "https://api.feedly.com"   # only for Enterprise tenants with their own host

[scope]
# which folders the agent gets to see at all. empty list = all
include_folders = ["AI"]
exclude_folders = ["Private", "Work - internal"]
default_folder  = "AI"        # used when the agent does not specify one

[defaults]
hours         = 8
limit         = 100
unread_only   = true
summary_chars = 400
full_text     = false         # enables summary_full

[budget]
daily_calls        = 40       # out of the verified 50 — the rest is saved for the browser
session_calls      = 15
session_idle_reset = "15m"    # quiet period that resets the session counter
warn_below         = 10       # warn in the tool response, not just in the log

[cache]
metadata_ttl = "24h"          # categories + subscriptions
articles_ttl = "15m"
dir          = "~/.cache/feedly-mcp"   # respects XDG_CACHE_HOME

[writes]
enabled        = false        # mark_read at all
bulk_mark_read = false        # mark_read on whole folders
```

### 4.3 `scope` must be enforced, not just filter the menu

If `include_folders` is set, `list_folders` must hide the rest **and**
`get_articles` must reject a `folder` outside the list — even when the agent
sends a raw ID it has seen somewhere else. If you only filter the listing, the
restriction is cosmetic.

This is also where the personal context belongs. That the main folder is called
`AI` is a user setting, not something that should live in the code.

---

## 5. API foundation

### ID shapes (verified)

```
user        user/<uuid>
category    user/<uuid>/category/<label|uuid>
feed        feed/<xml-url>
global      user/<uuid>/category/global.all
```

The category ID is either a readable name (older folders) or a UUID (newer
ones). Never assume either. Fetch the list from `/v3/categories` and look it
up.

The user ID comes from `/v3/profile`. Never hardcoded, never derived.

The `streamId` **must** be URI-encoded.

### Endpoints

| Method | Path | Use |
|---|---|---|
| GET | `/v3/profile` | verify token, get user ID |
| GET | `/v3/categories` | folders with `id` and `label` |
| GET | `/v3/subscriptions` | all feeds, with `categories[]` |
| GET | `/v3/streams/contents` | articles with content |
| GET | `/v3/streams/ids` | IDs only — cheaper for counting |
| GET | `/v3/markers/counts` | unread per feed and folder |
| POST | `/v3/markers` | mark as read |
| GET | `/v3/search/feeds` | find new sources |

`POST/DELETE /v3/subscriptions` is deliberately left out — see §8.

### streams/contents — parameters (verified against the docs)

| Param | Note |
|---|---|
| `streamId` | required, URI-encoded |
| `count` | 1–100, default 20 |
| `newerThan` | unix ms, **max 31 days back** |
| `olderThan` | unix ms |
| `unreadOnly` | bool |
| `ranked` | `newest` \| `oldest` |
| `continuation` | pagination; comes in the response |

The web app calls it like this (captured from the network log):

```
GET /v3/streams/contents
  ?streamId=user%2F<uuid>%2Fcategory%2FAI
  &count=40&unreadOnly=true&ranked=newest&similar=true
  &continuation=<id>&ct=feedly.desktop&cv=31.0.3124
```

### markers — body

```json
{"action":"markAsRead","type":"entries","entryIds":["..."]}
{"action":"markAsRead","type":"feeds","feedIds":["..."],"asOf":1755800000000}
```

---

## 6. Tool surface

Keep it small. Six tools cover all real use.

| Tool | In | Out |
|---|---|---|
| `list_folders` | – | `[{id,label,unread}]` |
| `list_feeds` | `folder?` | `[{id,title,folders[],unread}]` |
| `get_articles` | `folder?`, `hours?`, `unread_only?`, `limit?` | normalized articles |
| `unread_counts` | – | total + per folder |
| `search_feeds` | `query`, `limit?` | candidate sources with `feedId` |
| `mark_read` | `entry_ids[]` **or** `folder`+`older_than` | number marked |

Omitted parameters fall back to `[defaults]` in the configuration.

`folder` accepts both a readable label and a raw ID. The server looks it up
against the cached category list. The agent should never have to know UUIDs.

### Normalized article

Raw Feedly JSON is heavy — `content.content` can be the entire article.
Normalize before returning, otherwise one call eats the whole context window:

```json
{
  "id": "...",
  "title": "...",
  "source": "r/LocalLLaMA",
  "url": "https://...",
  "published": 1755800000000,
  "folders": ["AI", "AI - Local Models"],
  "engagement": 214,
  "summary": "trimmed to summary_chars, HTML stripped"
}
```

Do not return `content`, `visual`, raw `origin`, or `enclosure`.
`summary_full` goes behind `defaults.full_text`.

`folders[]` is filled in locally from the cached `/v3/subscriptions` and costs
nothing. Without it, deduplication is opaque — the agent cannot see why an
article appeared, or that it spans several folders at once.

`get_articles` additionally returns `truncated: true` when `limit` cut the
result. Otherwise the agent does not know whether it is seeing everything, and
cannot distinguish "little that is new" from "too much to show".

`search_feeds` returns `already_subscribed` per hit, derived locally from the
subscription list. Free, and prevents the agent from suggesting sources you
already have.

### Meta on every response

Every tool response carries a small meta object:

```json
{
  "calls_used": 12,
  "calls_left_today": 188,
  "fetched_at": 1755800000000,
  "from_cache": false
}
```

It is the user's own quota being burned. They are entitled to see it.
`fetched_at` lets the agent say "as of 14:03" instead of pretending everything
is fresh — and `from_cache` is what makes `fetched_at` interpretable, since a
cached answer can be `articles_ttl` old without anything else in the response
giving it away.

**Both fields must be pessimistic.** Several tools build their answer from more
than one request, which may be fresh or cached independently of each other.
`fetched_at` must therefore report the **oldest** source, and `from_cache` must
be true when **at least one** came from cache. If you use "all" instead of "at
least one", you get `from_cache: false` next to a two-hour-old timestamp — and
then the fields are worse than useless, because they contradict each other.

The trap is not theoretical: the first implementation hardcoded
`fetched_at: Date.now(), from_cache: false` in `list_folders` and did exactly
what this section exists to prevent.

### Error taxonomy

| Situation | Response |
|---|---|
| 401 from Feedly | "token expired" + renewal link + name of the environment variable |
| 429 from Feedly | clear error with `X-Ratelimit-Reset`. **No retry loop.** |
| Budget exhausted | its own error, distinct from 429 — it is the server's limit, not Feedly's |
| Folder outside `scope` | reject, and say it is outside the configured scope |

---

## 7. Rate limits — the most important design constraint

### Verified 2026-08-23 — the documentation is wrong

One call to `/v3/profile` with a developer token on a **Pro Plus** account
(`FeedlyProPlusYearly144`, active subscription) gave:

```
x-ratelimit-limit: 50
x-ratelimit-count: 1
x-ratelimit-reset: 41655        # ~11h34m → daily window, lands near midnight UTC
```

**50 calls per day.** Not 250, not 500. The documentation stating "250 on free,
500 on Pro" does not match what the API actually sends.

Unconfirmed hypothesis: the ceiling of 50 probably applies to **developer
tokens specifically**, not the account tier. That would explain the
contradiction. Verify against an OAuth token if you ever get one — but do not
spend quota digging into this without reason.

Practical consequence: **plan for 50.** If it is really more, the assumption
costs you nothing. If it is not, it saves the project.

### What 50 means

One conversation where the agent calls `list_folders`, then `unread_counts`,
then `get_articles` on three folders uses 6+ calls. That is eight conversations
a day.

This is not a limit you design around after the fact. It is the premise.
Caching is not an optimization here — it is what makes the tool usable.

Responses carry `X-Ratelimit-Count`, `X-Ratelimit-Limit` and
`X-Ratelimit-Reset`. Over the quota: HTTP 429.

The quota hangs on the account. Every user brings their own — they do not
compete for a shared pool. But it also means an over-eager agent drains *the
user's* quota, and then Feedly is unavailable in their browser too for the rest
of the day. The budget in §4.2 is the user's protection against their own
agent.

**`daily_calls` is measured account-wide, not per server.** It is checked
against `X-Ratelimit-Count`, which counts every client on the account —
including the browser. If the user has already spent 38 calls themselves today,
the server declines at 40 without having made a single one. That is deliberate:
the point is to leave behind a working Feedly.

But the error message must then state both figures. "This server's daily budget
is spent" would be outright false in that case, and worse: it would send the
user off to raise a ceiling that was not the problem.

Requirements:

- **Cache `/v3/categories` and `/v3/subscriptions` on disk**, not just in
  memory. The process dies between conversations; without a disk cache they
  are fetched anew every time. TTL from `cache.metadata_ttl`, which with the
  50-call ceiling should stay at **24h**. Fetched four times a day, that is
  8 of 50 calls spent on lists that almost never change. The trade-off is that
  a new subscription can take a day to appear — acceptable, given that
  `doctor --refresh` clears the cache when you need it.
- **One call per folder, never one per feed.** A folder-level `streamId`
  fetches everything under it.
- **If everything lives in one top-level folder, fetch only that.** Folder
  membership is computed locally from the cached `/v3/subscriptions`, which
  already provides `categories[]` per feed. One call then covers the whole
  subscription.
- **Memoize article responses** on (streamId, parameters) within
  `cache.articles_ttl`. If the agent asks twice about the same folder in the
  same conversation, it should cost one call.
- **Read `X-Ratelimit-Count` from every response** and expose it. Below
  `budget.warn_below`: a warning in the tool response, not just in the log.
- **Hard ceiling** at `budget.session_calls` and `budget.daily_calls`, no
  matter what the agent asks for. Two pitfalls, both observed in operation:

  **A stdio process is not one conversation.** Clients start the server once
  and keep it alive as long as the app runs — measured at over 15 hours — and
  every conversation shares it. An in-memory counter then only resets when the
  app exits, so "10 calls per session" in practice means "10 calls until you
  restart Claude". A scheduled run inherits a spent budget it can never clear.
  Use a gap in activity as the session boundary instead.

  **Checking without reserving does not hold.** Several tools fire concurrent
  calls — the folder index alone makes three. If you check the ceiling without
  counting up in the same operation, all three pass while the counter still
  sits below the limit. Measured: a ceiling of 10 reached 12, and the error
  message then said "12/10", which looks like a counter that never resets.
  Reserve the slot, and give it back if the call never went out.

---

## 8. Write operations

`mark_read` is **irreversible**. Feedly has no undo button, and recovery
requires emailing support. Therefore:

- Off by default. Enabled with `writes.enabled`.
- `mark_read` without `entry_ids` — that is, whole folders — additionally
  requires `writes.bulk_mark_read`. Two switches, because the two operations
  have completely different blast radii.
- **`unsubscribe` is not implemented.** It is deletion of the user's data,
  with no undo, performed by an agent. The value is not worth the risk. Let
  people unsubscribe in Feedly.
- **A field that reports what a write operation did must be measured — not
  assumed.** Feedly returns no count for folder-level marking. The first
  implementation returned the folder's unread count *before* the call under
  the name `marked_approximately`, with a footnote explaining it. In use it
  read as success: a sweep that hit nothing reported a five-figure number.
  Footnotes lose to field names. Measure the difference instead, and return
  `null` when it cannot be measured.
- Write operations always go live to Feedly and must invalidate affected cache
  entries. **Affected means more than the counters:** a cached
  `unreadOnly` response still contains the articles that were just marked
  read, and would serve them back for the rest of `articles_ttl`. Both
  `markers/counts` and all `stream:` entries must be cleared.

---

## 9. Architecture

Stdio server. One process, started by the MCP client on demand, dies
afterwards. The token stays with the user.

Four parts, kept apart:

```
tool layer      MCP tool definitions, validation, scope enforcement
client layer    Feedly HTTP, budget counting, error translation
cache layer     disk, TTL-based, only metadata + memoized responses
config layer    env → file → default
```

The cache lives under `~/.cache/feedly-mcp/` (or `XDG_CACHE_HOME`). One user
per installation — no user dimension in the storage.

### `doctor` command

`npx feedly-mcp doctor` shall:

1. find the token and say where it was found (never print it)
2. call `/v3/profile` and show the account
3. list folders with IDs — which is also the help the user needs to fill in `scope`
4. show quota usage and how long the token has left, if that can be read
5. say clearly if the configuration points to folders that do not exist

This is §10 step 1 turned into a tool, and it is the difference between
"doesn't work" and "oh, the token has expired".

---

## 10. Build order

1. `curl` against `/v3/profile` with a developer token from a **free
   account**. Settles §3 while proving the chain.
2. The config layer with precedence env → file → default. Everything else
   hangs on this.
3. `doctor`.
4. `list_folders` + `unread_counts` — the smallest thing that proves the whole
   chain.
5. Cache, budget and error taxonomy. **Before** more tools.
6. `get_articles` with normalization and pagination.
7. `search_feeds` and `list_feeds`.
8. `mark_read`, behind both flags.
9. Publish to npm. README with the token lifetime clearly near the top.
10. MCP Bundle.
11. The registry.

---

## 11. Pitfalls

- `newerThan` further back than 31 days yields an empty response, not an error.
  Therefore: `hours` is clamped to a max of 744 in the tool layer, and the
  clamping is called out in the response. If you let the value through
  untouched, "nothing in the last two months" looks like a valid result.
- `continuation` is missing from the response when you are at the end — do not
  interpret that as an error.
- Reddit feeds come as `feed/https://api.reddit.com/subreddit/<name>`;
  `origin.title` is then `r/<name>`.
- The same article can appear in several folders. Deduplicate on `id`.
- If all feeds also live in a top-level folder, do not sum unread counts across
  folders — everything gets double-counted.
- `engagement` is Feedly's popularity measure, useful for ranking, but missing
  or 0 on fresh items. Do not sort on it alone.
- A cache that survives a token change can serve data from the wrong account.
  Key the cache on the user ID from `/v3/profile`.
- Defaults like `hours = 8` are *your* habits. They must be overridable, and
  the README should say what they are.

---

## Appendix: account structure to test against

**Synthetic example.** No real IDs in this document — get your own from
`doctor`. The point is the shape, not the numbers.

The structure worth testing against is a top-level folder containing
everything, plus topic folders where the same feeds recur:

```
user ID       user/<uuid>
top folder    user/<uuid>/category/Topic         (70 feeds)

topic folders (newer folders have a UUID as ID, not a readable name):
  user/<uuid>/category/<uuid>   Subtopic A    12 feeds
  user/<uuid>/category/<uuid>   Subtopic B    15
  user/<uuid>/category/<uuid>   Subtopic C    13
  …
```

All 70 also live in the top folder. That makes this shape the most useful test
case in the spec, because it hits two things at once:

- **the single-call optimization in §7** — one call against the top folder
  covers the whole subscription, and folder membership is computed locally.
- **the double-counting trap in §11** — if you sum unread counts across
  folders, you count every article at least twice.

If your account has this shape, set the top folder as `default_folder`. It is
both the most useful and the cheapest default:

```toml
[scope]
include_folders = ["Topic"]
default_folder  = "Topic"
```
