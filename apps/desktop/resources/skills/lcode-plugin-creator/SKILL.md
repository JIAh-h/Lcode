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

**Every plugin has exactly this shape.** The install validator enforces it, so deviating does not
produce a "different style of plugin" — it produces a package that fails to install.

```
my-plugin/
├── lcode.json          # manifest (required; see references/manifest.md)
├── package.json        # required, must contain "type": "module"
├── src/index.js        # host entry, path must match lcode.json "entry" (required)
├── src/client.js       # optional client entry, only when contributes.client is declared
├── config.json         # optional user config, read via globalThis.__lcodePluginConfig
└── README.md           # what it does, what permissions it needs, known limits
```

What the validator checks at install time (violating any one fails the install, not at runtime):

| Check | Rule |
| --- | --- |
| `lcode.json` | Parses, `$schema` is `https://lcode.dev/schema/plugin-1.json`, closed field set |
| `package.json` | Exists and has `"type": "module"` |
| `entry` | Starts with `./`, ends with `.js`, no `..`, resolves to a real file inside the package |
| `contributes.client.entry` | Same rules, and the file must exist |
| `contributes.*` names | Match what `activate` actually registers |

Install location: `~/.lcode/plugins/<plugin-id>/<version>/`.

## Self-check before you hand the plugin over

Run these three; they catch every structural mistake seen so far:

```sh
# 1. manifest is valid (fails loudly on a bad $schema or entry)
node -e "const m=require('./lcode.json'); if(m.\$schema!=='https://lcode.dev/schema/plugin-1.json')throw new Error('bad \$schema'); if(!m.entry.startsWith('./'))throw new Error('entry needs ./')"

# 2. entry files load in plain Node
node --input-type=module -e "import('file:///<abs>/src/index.js').then(m=>console.log('host exports:',Object.keys(m)))"

# 3. package.json declares ESM
node -e "if(require('./package.json').type!=='module')throw new Error('need type: module')"
```

Then install it for real — a valid manifest is not an installable plugin until the validator has
seen it.

## Verify before claiming it works

A plugin that "typechecks" is not a plugin that loads. See `references/verification.md` for the
full checklist.

**Run `plugin_verify` — it is the only way to know.** It installs the plugin into a throwaway Home
(a fresh, isolated environment, deleted afterwards), activates it, and reports whether every
declared contribution actually registered. Nothing touches the user's real environment.

```
plugin_verify({ path: "<plugin dir>" })
→ { passed, inconclusive, declared: {...}, observed: {...}, problems, hint? }
```

How to read the result:

| Result | Meaning | What to do |
|---|---|---|
| `passed: true` | Every declared item registered | Report success — measured, not guessed |
| `passed: false` with `problems` | The plugin's own bug | Fix the code, run again until it passes |
| `inconclusive: true` | **Environment blocked the check** | **Stop editing the plugin.** Tell the user; quote `hint`. The code is not at fault |

`inconclusive` must not be glossed over — reporting "it works" on it is a false claim.

**Known limitation:** host-side loading (tools / prompt sections / listeners) cannot currently start
in this sandbox: the native sandbox denies the AppContainer read access to the Node executable's
directory, and that ACL cannot be granted here. Client-only plugins (themes, panels) do verify end
to end.

If `plugin_verify` is unavailable, fall back to manual checks and say which ones you ran:

1. `lcode.json` parses and matches the schema (`$schema` is `https://lcode.dev/schema/plugin-1.json`).
2. Entry files load in plain Node.
3. Every name in `contributes.*` matches a real registration call in `activate`.

## When the user's request does not fit

| Situation | Do this |
|---|---|
| Needs a capability the plugin cannot have (e.g. dynamic per-session prompt) | Say so; propose an alternative, do not fake it |
| Needs to depend on another plugin's service | Not supported in the current protocol — tell the user |
| Needs broad filesystem/network access | Declare it in `permissions` and explain why in `README.md`; the user sees the prompt |
