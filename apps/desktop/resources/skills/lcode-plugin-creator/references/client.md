# Client half: the renderer-side API

A plugin can extend the **interface**, not just the agent. This file covers that half.

The host half (`entry`, utility process) can register tools, prompt sections, and event listeners —
it **cannot** touch the UI at all. Anything visual needs a client half.

## Manifest

```json
{
  "contributes": {
    "client": {
      "entry": "./src/client.js",
      "slots": ["theme"]
    }
  }
}
```

| Field | Rules |
|---|---|
| `entry` | Package-relative `./…js`. Plain ESM JavaScript — **no TypeScript** (the renderer imports it directly). |
| `slots` | Which mount points to fill. At least one. Values below. |

Declaring `contributes.client` is independent of the host `entry`: you can ship only a client half
(the host `activate` can be an empty function), only a host half, or both.

## Slots

| Slot | Where it renders |
|---|---|
| `theme` | Nothing visible — applies CSS variables / background image globally |
| `sidebar.bottom` | Bottom of the left sidebar, above the account row |
| `conversation.top` | Above the conversation stream |
| `settings.section` | A panel in Settings |

A slot value outside this list is rejected at install time (`未知的界面插槽`).

## Entry shape

```js
export function render({ slot, api }) {
  // …return null (side effects only) or a node from api.h()
}
```

`render` is called on every React render of that slot. **Keep it pure**: it must not accumulate
state across calls. Module scope is fine for constants; for anything else, call `api.refresh()`.

Returning `null` means "nothing visible" — that is the normal return for `theme`.

## The `api` object

| Method | Purpose |
|---|---|
| `setCssVars({ '--x': 'value' })` | Override design tokens. Only `--custom-properties`, and the value cannot contain `;{}`. |
| `clearCssVars()` | Revert everything this plugin set |
| `setBackgroundImage({ url, size?, opacity? } \| null)` | Global wallpaper. `url` must be `https://` or `data:image/…` |
| `h(tag, content?, props?)` | Build a node description |
| `refresh()` | Re-render this slot (async data arrived) |

### Changing colors: override tokens, not properties

```js
// correct — one override recolors the whole app
api.setCssVars({ '--bg-canvas': '#1b1b26', '--text-primary': '#e8e8f0' })

// wrong — you would have to enumerate every element that uses them
document.body.style.background = '#1b1b26'
```

Every component reads `var(--token)`, so overriding the token changes everything at once. Setting
concrete properties only affects what you happen to list, and produces "half dark, half light".

Useful tokens: `--bg-canvas`, `--bg-elevated`, `--bg-inset`, `--text-primary`, `--text-secondary`,
`--text-muted`, `--border-subtle`, `--border-strong`, `--accent`, `--accent-weak`.

### Building UI

```js
export function render({ slot, api }) {
  return api.h('div', api.h('span', 'hello'), { class: 'my-panel' })
}
```

`api.h(tag, content, props)` — `content` is a string or another `h()` node. Use `class`, not
`className` (the host maps it). Blocked tags: `script`, `iframe`, `object`, `embed`, `link`, `meta`,
`style`, `form`.

**Don't expect to import React.** The plugin module gets no React instance; `api.h` is the only way
to create elements.

## Reading configuration

The plugin's `config.json` (in its install directory, next to `lcode.json`) is exposed at module
evaluation time:

```js
const cfg = globalThis.__lcodePluginConfig ?? {}

export function render({ api }) {
  api.setCssVars({ '--bg-canvas': cfg.canvas ?? '#14141c' })
  return null
}
```

Read it at **module scope** — it is only set before the module is evaluated, and is removed
immediately afterwards so plugins cannot read each other's config.

## Rules

1. **No imports of other files.** The module is loaded from a `data:`/`blob:` URL; relative imports
   fail. Ship one self-contained file.
2. **No Node APIs.** This runs in the renderer: no `fs`, no `child_process`, no `process`.
3. **Do not touch `document` directly** for anything persistent. Use the `api` so the host can
   revert your changes when the plugin is disabled. (Reading `document` is fine.)
4. **Do not throw from `render`.** A throwing plugin is disabled for the rest of the session — it
   will not be retried, and the user sees nothing.
5. **`https:` or `data:` only** for image URLs. `file:` would let a plugin probe the local disk.

## Verifying it actually applied

`render` returning successfully does not mean the styles took effect. Check:

- `document.documentElement.dataset.lcodePlugins` lists your plugin id,
- the host log shows `渲染层已加载 N 个 client 插件：<id>`,
- the visible change is there (a theme change is obvious; a panel is not).

If the id is absent, the module failed to load — look for `用 blob 加载失败` / `用 data 加载失败` in
the console.
