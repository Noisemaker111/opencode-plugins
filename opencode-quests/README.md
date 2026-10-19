# opencode-quests

Durable Quests, native worker dispatch, completion delivery and Quest Web APIs.

## Install

Run `bun install` in this directory once, then add this directory's absolute
path to `plugins` in your OpenCode configuration and reload.

## Check

Use the package through your OpenCode2 server, then inspect the saved result
after reopening. The builder checks entrypoint bundling; that does not prove
product behavior.

## Ownership

`plugin.json` declares entrypoints and runtime assets. `distribution.json`
records every shipped source and its hash. Relative dependencies are vendored
from the same source revision; no sibling repository layout is assumed.
The maintained source is the owner's directory in the QuestGiver repository;
[opencode-plugins](https://github.com/Noisemaker111/opencode-plugins) publishes
releases of these packages.

User configuration, account credentials, Quest ledgers and runtime state are
not distributed. Quest storage defaults to `~/.opencode/quests`;
`OPENCODE_QUEST_ROOT` explicitly overrides the ledger's project root.

## License

MIT
