# opencode-quests

Durable Quests, native worker dispatch, completion delivery and Quest Web APIs.

## What it does

Turns a stated goal into a stored Quest: title, steps, a chosen project, a worker run, completion delivery and verification evidence. It adds the Quest tools and Quest Web API, the giver session, worker admission and checkouts, and keeps the record on disk so a later session can resume it.

## What it needs

- an OpenCode 2 host
- one git checkout per project it works in
- the models plugin for routed worker runs

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
