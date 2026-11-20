---
name: cache-compact
description: Inspect or control proactive pre-cache-expiry thread compaction across Claude Code, Pi, and Antigravity CLI threads.
---

# Cache Compact

`cache-compact` automatically compacts eligible idle threads shortly before their prompt cache expires so compaction reads from a warm cache instead of waiting until the cache goes cold.

## How it works

- **Claude Code & Pi**: reads the provider's exact `promptCacheTtlMs` (from `thread/tokenUsage/updated` events) or `compactionOfferAt` (when BB's `compactExpiredCache` experiment is enabled), then calls `threads.compact()` `leadMinutes` before expiry.
- **Antigravity CLI (`antigravity-cli`)**: uses `fallbackTtlMinutes` (since ACP does not currently report `promptCacheTtlMs`) and sends `/compact` when the thread advertises the `compact` command, then marks the turn compacted so it never loops.
- **Safety checks**: never compacts if the cache already expired (avoids burning uncached tokens after sleep/offline periods), skips threads below `minTokens`, skips active/archived threads, queued messages, pending interactions, or parents with active child threads, and enforces a per-thread cooldown.

## CLI commands

```sh
bb cache-compact status [--json]
bb cache-compact check [thread-id] [--json]
bb cache-compact now [thread-id] [--force] [--json]
bb cache-compact opt-out [thread-id] [--json]
bb cache-compact opt-in [thread-id] [--json]
bb cache-compact reconcile [--json]
```

## Settings

Inspect or edit with `bb plugin config cache-compact`:

- `enabled` (default `true`)
- `minTokens` (default `100000`)
- `leadMinutes` (default `3`)
- `providers` (default `"claude-code,pi,antigravity-cli"`)
- `fallbackTtlMinutes` (default `60`)
- `cooldownMinutes` (default `10`)
- `skipWithActiveChildren` (default `true`)
