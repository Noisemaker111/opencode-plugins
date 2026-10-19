# opencode-plugins

OpenCode 2 server plugins. Each directory is one plugin: source is maintained
privately and this repository publishes a built copy at every tag. They are not
on npm, and they install by path.

## Install

1. Download `v0.1.1` as a zip from
   https://github.com/Noisemaker111/opencode-plugins/archive/refs/tags/v0.1.1.zip and unzip it, or
   clone `https://github.com/Noisemaker111/opencode-plugins`.
2. Run `bun install` once in each plugin directory you want.
3. Add that directory's absolute path to `plugins` in your `opencode.json`, then
   restart the OpenCode server.

A plugin does nothing until the host loads it; a missing item from its "Needs"
list leaves it inert or noisy rather than broken.

## Packages

### opencode-usage

*Typed subscription usage, telemetry, and quota-aware routing APIs.*

Tells you what your subscriptions have left. It reads the accounts your host already uses and reports observed quota windows, burn rate, forecast to a deadline, per-session history and token/cost telemetry through the usage_status, usage_experience, usage_pacing and usage_target tools, a usage CLI and a stdio MCP server. It starts no background collector.

**Needs:** an OpenCode 2 host; the provider accounts and their local sign-in or auth files.

### opencode-quests

*Durable Quests, native worker dispatch, completion delivery and Quest Web APIs.*

Turns a stated goal into a stored Quest: title, steps, a chosen project, a worker run, completion delivery and verification evidence. It adds the Quest tools and Quest Web API, the giver session, worker admission and checkouts, and keeps the record on disk so a later session can resume it.

**Needs:** an OpenCode 2 host; one git checkout per project it works in; the models plugin for routed worker runs.

### opencode-models

*Model routing, account policy and configured transport guards.*

Guards which models a session may run. It blocks unlisted providers and models for task and subagent spawns, refuses a mid-session model switch that breaks the access policy, serves the configured model list and instruction files, and starts the local jev bridge that answers judge and permission questions on a free or paid route.

**Needs:** an OpenCode 2 host; provider entries in opencode.jsonc; the accounts in auth.json that it guards; an OpenRouter key in auth.json only for the paid jev route.

### opencode-harness

*Vendor agent adapters and runtime integration.*

Keeps shell calls honest. It refuses polling loops, destructive git, commands written in the wrong shell and blind long runs before they execute, and it shortens huge tool output while saving the full text under logs/. It adds no tools of its own; it only tightens the ones you already have.

**Needs:** an OpenCode 2 host.

### opencode-project-router

*On-demand project discovery and destination-bound conversational routing.*

Finds the project you meant and keeps work pointed at it. It ranks the projects it knows against your own words, offers the top few when nothing stands out, records a project under an alias, clones an authorized repository without running its scripts, and binds a Quest to the directory you chose.

**Needs:** an OpenCode 2 host; the quests plugin for project_goal and project_verify.

### opencode-context-graph

*Live session token and Code Mode attribution for server consumers.*

Times the inner calls of Code Mode programs. When an execute call is slow, the recorded spans name the call that took the time instead of blaming the whole program. It adds no tools.

**Needs:** an OpenCode 2 host.

### opencode-cliproxyapi

*Keeps the local CLIProxyAPI subscription broker running from its verified config.*

Runs the local CLIProxyAPI broker for the subscription plans that need it. When a broker config exists it starts the broker and brings it back on demand if a request targets its address. It adds no tools.

**Needs:** an OpenCode 2 host; a CLIProxyAPI broker config file.

### opencode-agent-guard

*Runs the agent-guard command rules on every shell call: no polling, no blind long runs, no hidden errors, no wrong-shell syntax.*

Applies your own agent-guard command rules to every shell call, and installs the search-output helper that keeps large result sets readable. Without the external agent-guard package it loads only the helper.

**Needs:** an OpenCode 2 host; the agent-guard package on disk, at AGENT_GUARD_HOME or ~/Projects/agent-guard.

Account credentials, Quest ledgers and runtime state are not included.

## License

MIT
