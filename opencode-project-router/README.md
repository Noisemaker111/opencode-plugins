# opencode-project-router

On-demand project discovery and destination-bound conversational routing.

## What it does

Finds the project you meant and keeps work pointed at it. It ranks the projects it knows against your own words, offers the top few when nothing stands out, records a project under an alias, clones an authorized repository without running its scripts, and binds a Quest to the directory you chose.

## What it needs

- an OpenCode 2 host
- the quests plugin for project_goal and project_verify

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
