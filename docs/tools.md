# Tool reference

> All six tools are implemented. Every return shape below has been checked
> against a live Feedly account, except `mark_read`'s success path — see the
> warning in that section.

Six tools. You will rarely call them by name — ask Claude in plain language and
it picks. This document is for understanding what happens when it does, and what
each request costs you.

Parameters marked *optional* fall back to your
[configuration](configuration.md#defaults).

---

## Common to every response

### The `meta` block

Every tool returns a `meta` object alongside its result:

```json
{
  "calls_used": 12,
  "calls_left_today": 38,
  "calls_left_session": 7,
  "fetched_at": 1755800000000,
  "from_cache": false
}
```

`calls_left_today` comes from Feedly's own `X-Ratelimit-Count` header and is
absent until the first response of the day has been seen. `calls_left_session`
is this server's own per-conversation ceiling.

`fetched_at` is when the data was actually retrieved from Feedly, which is not
the same as now. When `from_cache` is `true`, it may be up to ten minutes old —
this is what lets Claude say *"as of 14:03"* rather than implying everything is
live.

When fewer calls remain than `budget.warn_below`, a `warning` field appears
here too.

### Folder arguments

Anywhere a `folder` is accepted, you can pass a **label** (`"AI - Research"`)
or a raw **ID** (`user/<uuid>/category/<uuid>`). Labels are matched
case-insensitively against your folder list.

Folders outside your configured [scope](configuration.md#scope) are rejected
whichever form you use.

---

## `list_folders`

Your folders and how much is unread in each.

**Parameters:** none

**Returns:**

```json
{
  "folders": [
    { "id": "user/d8a6…/category/AI", "label": "AI", "unread": 214 },
    { "id": "user/<uuid>/category/<uuid>",        "label": "AI - Research", "unread": 31 }
  ],
  "meta": { … }
}
```

**API cost:** 0–2 calls. Free when the folder list is cached, which it usually is.

> **Do not add these numbers up.** A feed can belong to several folders, so if
> your feeds also sit in one top-level folder, summing across folders
> double-counts everything. Use [`unread_counts`](#unread_counts) for a real
> total.

---

## `list_feeds`

The individual sources you subscribe to.

| Parameter | Type | Default | |
|---|---|---|---|
| `folder` | string | all in-scope folders | *optional* |

**Returns:**

```json
{
  "feeds": [
    {
      "id": "feed/https://api.reddit.com/subreddit/LocalLLaMA",
      "title": "r/LocalLLaMA",
      "folders": ["AI", "AI - Local Models"],
      "unread": 47
    }
  ],
  "meta": { … }
}
```

`folders` lists every folder the feed belongs to, not just the one you asked
about.

**API cost:** 0–2 calls, usually cached.

---

## `get_articles`

The main one. Recent articles, cleaned up and trimmed to something an agent can
actually read.

| Parameter | Type | Default | |
|---|---|---|---|
| `folder` | string | `scope.default_folder` | *optional* |
| `hours` | integer | `defaults.hours` (8) | *optional* — max 744 |
| `unread_only` | bool | `defaults.unread_only` (true) | *optional* |
| `limit` | integer | `defaults.limit` (100) | *optional* |

**Returns:**

```json
{
  "articles": [
    {
      "id": "…",
      "title": "…",
      "source": "r/LocalLLaMA",
      "url": "https://…",
      "published": 1755800000000,
      "folders": ["AI", "AI - Local Models"],
      "engagement": 214,
      "summary": "HTML stripped, trimmed to summary_chars"
    }
  ],
  "count": 43,
  "truncated": false,
  "folder": "AI - Research",
  "window_hours": 72,
  "meta": { … }
}
```

`truncated` is `true` when more matched than `limit` allowed, when the stream had
further pages, or when the budget stopped pagination early. Ask for a narrower
time window rather than raising `limit` — it costs less and reads better.

Two fields appear only when they apply:

- `note` — when `hours` was clamped to Feedly's 31-day ceiling.
- `stopped_early` — when the call budget ran out partway through pagination. You
  get the articles retrieved so far rather than an error.

### What is deliberately left out

Feedly's raw response is enormous; `content.content` can be an entire article.
Returning it unmodified would consume the context window in a single call. So
`content`, `visual`, `enclosure` and the raw `origin` object are dropped, and
summaries are trimmed.

Set [`defaults.full_text`](configuration.md#defaults) to add a `summary_full`
field with a longer extract, if you know you want it.

### Notes

- Articles appearing in several folders are **deduplicated by `id`**. You get one
  entry, with every folder it belongs to listed.
- `engagement` is Feedly's popularity measure. It is useful for ranking but is
  missing or zero on fresh items, so sorting on it alone buries new material.
- Asking for more than 744 hours (31 days) returns nothing rather than an error.
  This is a Feedly limitation. The server clamps the value and says so.
- Pagination is handled internally. You will not see continuation tokens.

**API cost:** 1 call per page, so 1–3 for a typical request. Free if the
identical request was made within `cache.articles_ttl`.

---

## `unread_counts`

How much is waiting, without fetching any articles.

**Parameters:** none

**Returns:**

```json
{
  "total": 4425,
  "total_is_account_wide": true,
  "by_folder": [
    { "label": "AI", "unread": 4317 },
    { "label": "AI - Research", "unread": 68 }
  ],
  "meta": { … }
}
```

`total` is deduplicated and is the number to trust — it comes from Feedly's own
`global.all` row. The per-folder figures are for orientation and will not sum to
it.

`total_is_account_wide` is `true` when that row was available. When a
[scope](configuration.md#scope) is configured, an extra `note` says so: the total
still covers the whole account, while `by_folder` is limited to folders in scope.

**API cost:** 1 call. This is the cheapest useful thing you can ask — a single
request covers your whole account.

---

## `search_feeds`

Find sources to subscribe to. Searches Feedly's catalogue of publications — not
your own subscriptions, and **not article text**.

Query with a topic or a publication name (`"machine learning"`,
`"MIT Technology Review"`). A phrase describing article content
(`"local llm inference"`) returns an empty list, verified against the live API.
When nothing matches, the response includes a `hint` saying so.

| Parameter | Type | Default | |
|---|---|---|---|
| `query` | string | — | **required** |
| `limit` | integer | 10 | *optional* |

**Returns:**

```json
{
  "results": [
    {
      "feedId": "feed/https://example.com/rss",
      "title": "Example Blog",
      "website": "https://example.com",
      "subscribers": 4210,
      "description": "…",
      "already_subscribed": true
    }
  ],
  "meta": { … }
}
```

`already_subscribed` is resolved locally from your cached subscription list, so
it costs nothing.

**Subscribing is not implemented.** Take the `feedId` or the website URL and add
it in Feedly. See [below](#a-note-on-what-is-missing).

**API cost:** 1 call.

---

## `mark_read`

**Permanent. Disabled by default.** Feedly has no undo; recovery means emailing
their support.

Requires [`writes.enabled = true`](configuration.md#writes). Folder-level marking
requires `writes.bulk_mark_read = true` as well.

> **Untested against the live API.** Every other tool here has been exercised
> against a real account. This one has not, because there is no way to undo a
> successful call and no safe article to sacrifice. Its refusal paths are tested;
> its success path is code review only. Treat the first real use as a test, and
> start with a single `entry_ids` value.

Call it one of two ways:

**By article** — requires `writes.enabled`:

| Parameter | Type | |
|---|---|---|
| `entry_ids` | list of strings | **required** |

**By folder** — requires `writes.bulk_mark_read` too:

| Parameter | Type | |
|---|---|---|
| `folder` | string | **required** |
| `older_than` | timestamp or duration | *optional*, e.g. `"7d"` |

**Returns:**

By article:

```json
{ "marked": 12, "scope": "12 articles by ID", "permanent": true, "meta": { … } }
```

By folder — Feedly returns no count for a category-level mark, so the figure is
the folder's unread count taken *before* the call, and is named accordingly:

```json
{
  "marked_approximately": 68,
  "scope": "folder:AI - Research older than 7d",
  "permanent": true,
  "note": "Feedly does not return a count for folder-level marking. …",
  "meta": { … }
}
```

The second form can mark thousands of articles from one call, which is why it
sits behind its own switch. Omitting `older_than` marks the entire folder read.

Affected cache entries are invalidated immediately, so unread counts stay
truthful.

**API cost:** 1 call, plus 1–2 to refresh counts.

---

## Errors

Errors are returned as readable messages, never stack traces, and never contain
your token.

| Error | Meaning | What to do |
|---|---|---|
| `token_expired` | Feedly returned 401 | Get a new token. Free-account tokens last ~30 days. The message includes the link. |
| `rate_limited` | Feedly returned 429 | Your account's daily quota is gone. The message gives the reset time. **The server does not retry** — retrying makes it worse. |
| `budget_exhausted` | *This tool's* ceiling was hit | Not the same as above: you still have Feedly quota left. Raise [`budget.daily_calls`](configuration.md#budget) if you meant to. |
| `out_of_scope` | Folder excluded by config | Add it to `scope.include_folders`, or clear the list. |
| `writes_disabled` | `mark_read` called while off | Enable it in config — after deciding you want an agent marking things read. |
| `folder_not_found` | No such label or ID | Run `doctor` for the real list. |

---

## A note on what is missing

There is no `subscribe`, no `unsubscribe`, no folder management, and no OPML
import or export.

Unsubscribing is deletion of your data, with no undo, performed by an agent that
may have misread you. The value does not come close to the risk, so it is absent
at every configuration level rather than hidden behind a flag.

The design rationale, including everything else deliberately excluded, is in
[feedlymcpspec.md](../feedlymcpspec.md).
