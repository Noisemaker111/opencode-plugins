# opencode-plugins

This isnt ready yet, plz know you are trying this at your own risk. Some of these depend on each other and that isn't made clear or cleanly cut either, working on that.

OpenCode 2 server plugins built from Quest Giver. Source is maintained privately;
this repository publishes a built copy of each package at every tag.

## Install

1. Download `v0.1.0` as a zip from
   https://github.com/Noisemaker111/opencode-plugins/archive/refs/tags/v0.1.0.zip and unzip it, or
   clone `https://github.com/Noisemaker111/opencode-plugins`.
2. Run `bun install` once in each plugin directory you want.
3. Add that directory's absolute path to `plugins` in your `opencode.json`, then
   restart the OpenCode server.

## Packages

- `opencode-usage`: Typed subscription usage, telemetry, and quota-aware routing APIs
- `opencode-quests`: Durable Quests, native worker dispatch, completion delivery and Quest Web APIs
- `opencode-models`: Model routing, account policy and configured transport guards
- `opencode-harness`: Vendor agent adapters and runtime integration
- `opencode-project-router`: On-demand project discovery and destination-bound conversational routing
- `opencode-context-graph`: Live session token and Code Mode attribution for server consumers
- `opencode-cliproxyapi`: Keeps the local CLIProxyAPI subscription broker running from its verified config
- `opencode-agent-guard`: Runs the agent-guard command rules on every shell call: no polling, no blind long runs, no hidden errors, no wrong-shell syntax

`opencode-project-router` and `opencode-quests` work together; the router needs
Quest storage to be useful. Account credentials, Quest ledgers and runtime state
are not included.

## License

MIT
