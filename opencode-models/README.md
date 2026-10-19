# opencode-models

Model routing, account policy and configured transport guards.

## What it does

Guards which models a session may run. It blocks unlisted providers and models for task and subagent spawns, refuses a mid-session model switch that breaks the access policy, serves the configured model list and instruction files, and starts the local jev bridge that answers judge and permission questions on a free or paid route.

## What it needs

- an OpenCode 2 host
- provider entries in opencode.jsonc
- the accounts in auth.json that it guards
- an OpenRouter key in auth.json only for the paid jev route

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
