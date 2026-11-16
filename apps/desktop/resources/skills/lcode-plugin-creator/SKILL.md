---
name: lcode-plugin-creator
description: Create, package, and validate Lcode plugins (custom tools, prompt sections, event listeners). Use when the user asks to build a plugin, extend Lcode with a custom tool, add a slash command or automatic behavior, or package existing code as an installable plugin.
---

# Create Lcode Plugins

A plugin is a folder with `lcode.json` (manifest) + `src/index.js` (entry). Lcode loads it in a
separate utility process: your code never gets the host's `ctx`, filesystem, or network directly —
everything goes through the capability API described in `references/plugin-api.md`.

## Before you start: plugin or skill?

| Goal | Build |
|---|---|
| Reusable prompt / workflow / checklist | **Skill** (use `skill-creator`) |
| Needs to run code: read files, call commands, hit the network | **Plugin** (host half) |
| Change the look, add a panel, inject CSS | **Plugin** (client half) |
| Both (a tool that also injects instructions) | **Plugin** with a `promptSection` |

Do not build a plugin for a one-off request. Do not build a skill when the job needs to execute code.

## A plugin has two halves

| Half | Runs in | Can do |
|---|---|---|
| **host** (`entry`) | separate utility process | tools, prompt sections, event listeners, file/network access |
| **client** (`contributes.client`) | renderer (browser) | themes, background images, panels |

Either half alone is a valid plugin. **The host half cannot touch the interface at all** — so a
request like "change the skin" or "add a settings panel" needs the client half.
See `references/client.md`, and `templates/theme-plugin/` for a working skin.

## Evidence order — look it up, do not guess

The capability API changes between versions. When unsure, read in this order:

1. An installed plugin's `lcode.json` + `src/` under `~/.lcode/plugins/` — real working examples.
2. `docs/13-插件SDK与协议设计.md` in this repository (if visible).
3. `packages/extension/plugin-sdk/src/protocol.ts` — the authoritative type definitions.
4. Still unclear: write the smallest thing that can fail safely, and record the assumption in
   the plugin's `README.md`.

Never invent an API shape. A wrong method name fails at activation, and the error surfaces to the
user as "plugin failed to load", not as a compile error.

## Start from a template, not a blank file

Copy one of these and edit — they already satisfy every rule below:

| Template | Use when |
|---|---|
| `templates/tool-plugin/` | Adding a new tool the model can call |
| `templates/prompt-plugin/` | Injecting standing instructions into every session |
| `templates/listener-plugin/` | Reacting to session/tool events |
| `templates/theme-plugin/` | Changing the interface (skin, colors, wallpaper) |

## Four rules — violating any one means it will not load

1. **`contributes` must declare everything you register.** Every tool name in
   `lcode.json` → `contributes.tools`, every prompt section id in `contributes.promptSections`,
   every event in `activation.events`. Registration of an undeclared item throws at activation.
2. **Register inside `activate`.** Do not register at module top level — it runs before the host
   handshake and the registration is lost.
3. **Every resource returns a disposer.** Timers, listeners, child processes, open handles.
   `deactivate` must leave nothing running; the host disposes the process either way, but a plugin
   that fails to release resources leaks until the process is killed.
4. **`entry` must exist and load in plain Node.** It is loaded with `import()`, so it must be ESM
   (or CommonJS) JavaScript. **No TypeScript at runtime** — build it first, ship the output, and
   point `entry` at the built file.

Rules for the **client** half (additional, see `references/client.md`): one self-contained file,
no imports, no Node APIs, no React — use `api.h`.

## Directory layout

```
my-plugin/
├── lcode.json          # manifest (see references/manifest.md)
├── src/index.js        # host entry (references/plugin-api.md)
├── src/client.js       # optional client entry (references/client.md)
├── config.json         # optional user config, read via globalThis.__lcodePluginConfig
├── README.md           # what it does, what permissions it needs, known limits
└── package.json        # optional; only if you ship dependencies
```

Install location: `~/.lcode/plugins/<plugin-id>/`.

## Verify before claiming it works

A plugin that "typechecks" is not a plugin that loads. See `references/verification.md` for the
full checklist. The minimum:

1. `lcode.json` parses as JSON and matches the manifest schema.
2. `node --input-type=module -e "import('file:///<abs path to entry>')"` resolves without error.
3. `contributes.tools` names match the `registerTool` calls in `activate`.
4. Install into a scratch profile and confirm the tool appears in the model's tool list.

**Do not report success from reading the code.** Load it.

## When the user's request does not fit

| Situation | Do this |
|---|---|
| Needs a capability the plugin cannot have (e.g. dynamic per-session prompt) | Say so; propose an alternative, do not fake it |
| Needs to depend on another plugin's service | Not supported in the current protocol — tell the user |
| Needs broad filesystem/network access | Declare it in `permissions` and explain why in `README.md`; the user sees the prompt |
