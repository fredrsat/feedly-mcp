# feedly-mcp

Read your Feedly subscriptions from Claude. Ask *"what's new in my AI feeds?"* and
get an answer, without opening a browser.

> **Not published yet.** The server works and all six tools have been exercised
> against a live account, but it is not on npm and there are no releases.
> [Install from source](#step-2--install) — that path works today; the `npx` and
> `.mcpb` ones do not.

---

## What it does

Six tools that let an agent read your Feedly account:

| Tool | What it gives you |
|---|---|
| `list_folders` | your folders, with unread counts |
| `list_feeds` | the feeds in a folder |
| `get_articles` | recent articles, cleaned up and trimmed |
| `unread_counts` | how much is waiting, total and per folder |
| `search_feeds` | find new sources to subscribe to |
| `mark_read` | mark articles as read *(off by default)* |

## What it does not do

This is a **connector, not a reader app**. It translates a request into a Feedly
API call and hands back a clean answer. It does not store your articles, build a
searchable archive, rank things over time, or send you digests.

Those are all good things to want — build them *on top* of this, in a Claude
Project, a skill, or a scheduled task. Keeping them out is what makes this small
enough to trust.

## Privacy

Everything runs on your own machine.

- Your Feedly token stays local. It is never sent anywhere except `api.feedly.com`.
- No account with us, no server in the middle, no telemetry.
- Nothing about what you read is stored beyond a short-lived local cache.

---

## Requirements

- **Node.js 20 or newer** — check with `node --version`
- **A Feedly account** and an API token (step 1 below)
- Claude Desktop, Claude Code, or any other MCP client

---

## Step 1 — Get a Feedly API token

1. Log in to Feedly in your browser.
2. Visit **<https://feedly.com/v3/auth/dev>**.
3. Follow the instructions there to generate a developer access token.
4. Copy the token somewhere safe for the next step. It is a password — treat it
   like one.

> **Two things to know before you go further.**
>
> **Tokens expire.** On a free account a developer token is valid for about
> **30 days**, after which you repeat this step. Paid plans can refresh
> automatically. This is Feedly's policy, not something this tool can work around.
>
> **Token availability depends on your plan.** Feedly's own documentation is
> inconsistent about which account tiers can self-issue API tokens. If the page
> above does not give you a token, this connector cannot work with your account,
> and there is no workaround short of contacting Feedly.

---

## Step 2 — Install

### Build from source — the only path that works today

```bash
git clone https://github.com/fredrsat/feedly-mcp
cd feedly-mcp
npm install
npm run build
```

Then store your token in a file only you can read, so it never has to go into a
client config in plain text:

```bash
mkdir -p ~/.config/feedly-mcp
printf '%s' 'paste-your-token-here' > ~/.config/feedly-mcp/token
chmod 600 ~/.config/feedly-mcp/token
```

The server refuses to read that file if it is group- or world-readable, and tells
you how to fix it.

Register it with your client, using an **absolute path** to the built entry point:

```bash
# Claude Code — --scope user makes it available in every directory
claude mcp add feedly --scope user -- node /absolute/path/to/feedly-mcp/dist/cli.js

claude mcp list   # should report: feedly ... ✔ Connected
```

For Claude Desktop, add this to
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows), then quit and reopen the
application — closing the window does not reload MCP servers:

```json
{
  "mcpServers": {
    "feedly": {
      "command": "node",
      "args": ["/absolute/path/to/feedly-mcp/dist/cli.js"]
    }
  }
}
```

Already have other servers under `mcpServers`? Add `feedly` alongside them rather
than replacing the block.

If you move the repository afterwards, re-register it — the path is absolute.
Rebuilding in place is picked up automatically.

### Once published

Neither of these works yet; they are what installing will look like after the
first release.

**One-click, Claude Desktop.** Download `feedly-mcp.mcpb` from the Releases page
and drag it into **Settings → Extensions**. A settings form appears; the token
goes into your operating system's keychain rather than a plain-text file, and
everything in [Configuration](docs/configuration.md) is editable from that form.

**From npm.** `npx -y feedly-mcp` as the command, with `FEEDLY_TOKEN` in the
client's `env` block, or the token file above.

---

## Step 3 — Check that it works

Before asking Claude anything, confirm the connection from your terminal:

```bash
node dist/cli.js doctor
```

A healthy result looks like this:

```
✓ Config loaded from /Users/you/.config/feedly-mcp/config.toml
    scope.default_folder = Tech  ← file

✓ Token found        (file /Users/you/.config/feedly-mcp/token)
✓ Connected to Feedly you@example.com
    plan: FeedlyProYearly
✓ 8 folders, 70 feeds

  Tech             70 feeds  4317 unread  user/<uuid>/category/Tech
  Tech - Research  11 feeds    68 unread  user/<uuid>/category/<uuid>
  Tech - Tooling    6 feeds   171 unread  user/<uuid>/category/<uuid>
  …

  API calls used today: 4 of 50   (resets in 11h34m)
  Configured ceiling:   40/day account-wide, 10/session
  Through this server:  4 today, 4 in this run

✓ Everything checks out.
```

Useful flags: `-v` prints every resolved setting and where it came from,
`--refresh` clears the cache first.

`doctor` never prints your token. Use the folder list it gives you when filling
in `scope` in step 4.

If something is wrong, jump to [Troubleshooting](#troubleshooting).

---

## Step 4 — Configure (optional)

The defaults are sensible and you can skip this entirely. The one setting worth
looking at early is **scope** — which folders Claude is allowed to see at all.

Create `~/.config/feedly-mcp/config.toml`:

```toml
[scope]
# Only these folders are visible to the agent. Leave empty for all of them.
include_folders = ["AI", "Longform"]

# Used when you ask about articles without naming a folder.
default_folder = "AI"

[defaults]
hours = 8          # how far back get_articles looks
limit = 100        # max articles per call
```

Two reasons to set `include_folders`:

- **Privacy.** Your work folder does not need to be readable by an agent.
- **Focus.** Fewer folders means shorter answers and less context spent on
  material you did not ask about.

If you installed via Option A, edit these in the extension's settings form
instead — same options, no file to find.

Full list of settings: **[docs/configuration.md](docs/configuration.md)**

---

## Using it

Just ask. Some things that work well:

- *"What's new in my AI feeds since yesterday?"*
- *"Anything worth reading in AI - Research this week?"*
- *"How many unread articles do I have, broken down by folder?"*
- *"Find me feeds about local LLM inference"*
- *"Summarise the top 5 by engagement from the last 8 hours"*

You don't need to know folder IDs. Folder names work, and Claude can list them.

Full tool reference: **[docs/tools.md](docs/tools.md)**

---

## Your API quota — please read this

**Your daily API quota is small — smaller than Feedly's documentation suggests.**

Measured against the live API, a developer token on a paid Pro Plus account
reports a ceiling of **50 calls per day**, resetting around midnight UTC. Feedly's
own docs describe 250 on free and 500 on Pro. Plan for 50.

That is roughly eight conversations a day if the agent is chatty, and the quota
is shared with everything else touching your account — **including Feedly in your
browser**, which stops working too if an agent drains it.

So this tool defends the budget on your behalf:

- Folder and subscription lists are cached on disk for 24 hours.
- Repeated identical requests within 15 minutes are served from cache.
- One call fetches a whole folder — never one call per feed.
- Hard ceilings at 10 calls per session and 40 per day, leaving headroom for you.
  The daily one is measured account-wide, so browsing Feedly yourself counts
  against it — that is deliberate, so an agent cannot lock you out of your own
  reader.
- Every response reports how much quota is left and how stale the data is. Below
  10 calls remaining, you get a warning.

Check your own ceiling with `doctor` — it prints the limit your account actually
reports. If it says something higher than 50, you can safely raise the budget in
[configuration](docs/configuration.md#budget).

---

## Marking articles as read

`mark_read` is **permanent**. Feedly has no undo, and recovery means emailing
their support. So it ships disabled.

To enable single-article marking:

```toml
[writes]
enabled = true
```

To also allow marking an entire folder read in one go — a much bigger blast
radius — you must turn on a second switch deliberately:

```toml
[writes]
enabled = true
bulk_mark_read = true
```

Unsubscribing is not implemented at all, on purpose. Do that in Feedly.

---

## Troubleshooting

### `doctor` says the token is missing

The server looks in this order: the `FEEDLY_TOKEN` environment variable, then
the file named by `feedly.token_file`. Confirm your token reached whichever one
you used — a common cause is editing the config file while Claude Desktop passes
an empty environment variable that wins over it.

### "Token expired" or 401

Free-account tokens last about 30 days. Repeat [step 1](#step-1--get-a-feedly-api-token)
and update the token where you stored it. This is expected and will keep
happening; it is not a bug.

### Claude doesn't see the tools

Quit and reopen Claude Desktop completely — a window restart does not reload MCP
servers. Then check your JSON is valid (a trailing comma is the usual culprit),
and that `node --version` reports 20 or higher.

### "Rate limit exceeded" (429)

You have used your Feedly quota for the day. It resets on Feedly's schedule; the
error message includes the reset time. The server will not retry automatically —
retrying would only dig the hole deeper.

### "Daily budget exhausted"

Different from the above: this is *this tool's* ceiling, not Feedly's, and you
still have real quota left. Raise `budget.daily_calls` if you want more.

### A folder is "outside configured scope"

`scope.include_folders` is set and that folder isn't in it. Add it, or clear the
list to allow everything.

### Cached data looks like it belongs to another account

Clear the cache and try again:

```bash
rm -rf ~/.cache/feedly-mcp
```

---

## Development

```bash
npm run build      # compile to dist/
npm test           # 104 tests, no API calls
npm run typecheck  # tsc --noEmit
```

There is also an end-to-end check that drives the built server over stdio as a
real MCP client and exercises every tool against your account. It costs a handful
of API calls out of the daily 50, and prints the remaining quota as it goes:

```bash
node --env-file=.env scripts/smoke.mjs
```

`mark_read` is only exercised in its refusal paths, there and everywhere else.
It is irreversible, so there is no safe way to test the success path.

## Contributing

Issues and pull requests welcome. The design rationale — including which
features are deliberately excluded — lives in
[feedlymcpspec.md](feedlymcpspec.md). Read it before proposing a feature; if
your idea is in the "not in scope" list, that is a decision rather than an
oversight, though it is one you are welcome to argue with.

The spec and these docs are the contract. If you change a return shape or a
config key, change both together or neither.

## License

MIT
