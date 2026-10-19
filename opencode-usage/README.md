# opencode-usage

Typed subscription usage, telemetry, and quota-aware routing APIs.

## What it does

Tells you what your subscriptions have left. It reads the accounts your host already uses and reports observed quota windows, burn rate, forecast to a deadline, per-session history and token/cost telemetry through the usage_status, usage_experience, usage_pacing and usage_target tools, a usage CLI and a stdio MCP server. It starts no background collector.

## What it needs

- an OpenCode 2 host
- the provider accounts and their local sign-in or auth files

## Install

Run `bun install` in this directory once, then add this directory's absolute
path to `plugins` in your OpenCode configuration and reload.

## Check

Use the package through your OpenCode2 server, then inspect the saved result
after reopening. The builder checks entrypoint bundling; that does not prove
product behavior.

## Files

`plugin.json` declares entrypoints, runtime assets, what the package does and
what it needs. `distribution.json` records every shipped source and its hash.
Relative dependencies are vendored from the same source revision; no sibling
repository layout is assumed. The maintained source is the owner's directory in
the QuestGiver repository;
[opencode-plugins](https://github.com/Noisemaker111/opencode-plugins) publishes
releases of these packages.

User configuration, account credentials, Quest ledgers and runtime state are
not distributed. Quest storage defaults to `~/.opencode/quests`;
`OPENCODE_QUEST_ROOT` explicitly overrides the ledger's project root.

## License

MIT
