# Plugin manifest (`lcode.json`)

Loaded by `parsePluginManifest` in `packages/extension/plugin-manifest/src/manifest.ts`. Unknown
fields are rejected — the schema is closed, so a typo fails loudly instead of being ignored.

## Minimum viable manifest

```json
{
  "$schema": "https://lcode.dev/schemas/plugin/v1.json",
  "id": "acme.hello-tool",
  "name": "Hello Tool",
  "version": "0.1.0",
  "engines": { "lcode": "^0.1.0" },
  "entry": "src/index.js",
  "permissions": {},
  "contributes": { "tools": ["hello"] }
}
```

## Fields

| Field | Required | Rules |
|---|---|---|
| `$schema` | yes | Must be the plugin schema URL |
| `id` | yes | Lowercase, dot-separated, at least two segments: `^[a-z0-9]+(?:[.-][a-z0-9]+)+$`. Used as the install directory name. |
| `name` | yes | Human-readable, shown in the plugin list |
| `version` | yes | Semver |
| `engines.lcode` | yes | Semver range against the host version |
| `entry` | yes | Path **relative to the manifest**, pointing at loadable JS |
| `activation` | no | `{ events?: string[], languages?: string[], workspaceTrust?: "trusted" }` |
| `permissions` | yes | Omitting it means **zero permissions** — never an implicit widening |
| `configSchema` | no | JSON Schema for the plugin's config object |
| `contributes` | yes | What the plugin provides; see below |

## `contributes` — declare before you register

```json
{
  "contributes": {
    "tools": ["my_tool"],
    "promptSections": ["my-instructions"],
    "services": []
  }
}
```

The host cross-checks every registration against this list. Registering `my_tool` when
`contributes.tools` does not contain it throws:

```
Tool my_tool is not declared in the plugin manifest
```

The reverse (declaring but never registering) is not an error, but it is a bug: the manifest
promises a capability the plugin does not deliver.

## `permissions` — declare the minimum

```json
{
  "permissions": {
    "fs": { "read": ["~/.lcode/**"], "write": [] },
    "network": { "domains": ["api.example.com"] },
    "spawn": { "allow": [] },
    "env": { "read": [] }
  }
}
```

| Scope | Meaning |
|---|---|
| `fs.read` / `fs.write` | Path globs the plugin may touch. Anything outside is denied at the capability layer. |
| `network.domains` | Hostnames the plugin may reach. No wildcard subdomain matching. |
| `spawn.allow` | Executables the plugin may launch |
| `env.read` | Environment variable **names** it may read (values are never passed wholesale) |

Start empty and add only what the plugin proves it needs. The user sees this list when installing;
a plugin asking for broad access is one they will refuse.

## `activation`

| Key | Effect |
|---|---|
| `events` | The plugin only starts when one of these events first fires (lazy). Every event you `registerListener` on must be listed here. |
| `languages` | Only activate in workspaces containing these languages |
| `workspaceTrust` | `"trusted"` means do not activate in untrusted workspaces |

Omit `activation` entirely for a plugin that should be active from startup.

## `configSchema`

If the plugin takes config, declare it — the settings UI renders a form from it.

```json
{
  "configSchema": {
    "type": "object",
    "properties": {
      "greeting": { "type": "string", "description": "Text returned by the tool" }
    },
    "required": ["greeting"]
  }
}
```

A schema that does not match the user's config rejects the manifest at install time. Do not rely
on runtime defaults for required fields — put defaults in the schema (`"default": "hello"`).

## Common rejections

| Message | Cause |
|---|---|
| `lcode.json 必须是对象` | File is not a JSON object |
| `未知字段: x` | Typo or a field from a future version |
| `id 不符合…` | Single-segment id, uppercase, or underscore |
| `entry 必须…` | Absolute path, or a path escaping the plugin directory |
| `contributes.tools 不是数组` | Wrong shape |
