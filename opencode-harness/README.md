# opencode-harness

Vendor agent adapters and runtime integration.

## What it does

Keeps shell calls honest. It refuses polling loops, destructive git, commands written in the wrong shell and blind long runs before they execute, and it shortens huge tool output while saving the full text under logs/. It adds no tools of its own; it only tightens the ones you already have.

## What it needs

- an OpenCode 2 host

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
