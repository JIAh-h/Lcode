# Dusk Theme

A working Lcode **client** plugin: recolors the interface by overriding design tokens.

## What it does

Registers a `theme` slot and sets four CSS variables (`--bg-canvas`, `--bg-elevated`,
`--text-primary`, `--accent`). Colors come from the plugin's `config.json`, so the same package can
ship several skins.

This also demonstrates the **two-half** structure: `src/index.js` is the host half (empty here),
`src/client.js` is the client half.

## Install

```sh
mkdir -p ~/.lcode/plugins/acme.dusk-theme/0.1.0
cp -r ./* ~/.lcode/plugins/acme.dusk-theme/0.1.0/
```

Restart Lcode. The interface should turn dark.

## Configuration

Create `config.json` next to `lcode.json`:

```json
{ "canvas": "#1b1b26", "text": "#e8e8f0", "accent": "#8fa8ff" }
```

Omit it to use the defaults baked into `src/client.js`.

## How it works

```js
api.setCssVars({ '--bg-canvas': cfg.canvas })
```

Every component styles itself with `var(--token)`. Overriding the token recolors the entire app in
one call — that is why themes need nothing but the `theme` slot.

Do **not** set concrete properties like `background` directly: you would have to list every element,
and get a half-themed interface.

## Why the host half exists but is empty

`lcode.json` declares `entry` (host) and `contributes.client`. The host half is optional in
practice, but keeping it shows the shape: `src/index.js` exports `activate`, `src/client.js` exports
`render`. A client-only plugin can keep `activate` empty like this one.

## Known limits

- One self-contained file: relative imports and Node APIs are unavailable in the client half.
- No React: build nodes with `api.h(tag, content, props)`.
- The client half does not need the host half to activate successfully — they load independently.
