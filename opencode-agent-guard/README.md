# opencode-agent-guard

Runs the agent-guard command rules on every shell call: no polling, no blind long runs, no hidden errors, no wrong-shell syntax.

## What it does

Applies your own agent-guard command rules to every shell call, and installs the search-output helper that keeps large result sets readable. Without the external agent-guard package it loads only the helper.

## What it needs

- an OpenCode 2 host
- the agent-guard package on disk, at AGENT_GUARD_HOME or ~/Projects/agent-guard

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
