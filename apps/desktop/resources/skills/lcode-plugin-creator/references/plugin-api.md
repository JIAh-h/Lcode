# Plugin API

Source of truth: `packages/extension/plugin-sdk/src/protocol.ts`. If this file and the code disagree,
**the code wins** — this document lags by design (the API is pre-stable).

The plugin runs in its own utility process. `ctx` here is a proxy: every call is an async RPC to the
host. Nothing is synchronous, and the host process objects are never exposed.

## Entry shape

```js
// src/index.js
export async function activate(ctx, config) {
  // register everything here; return a disposer
  return () => {
    // optional cleanup
  }
}
```

| Export | Required | Notes |
|---|---|---|
| `activate(ctx, config)` | yes | Called once after the host handshake. `config` is validated against `configSchema`. |
| `deactivate()` | no | Optional. The host disposes the process regardless; use it for graceful shutdown. |

Do **not** call `ctx` methods at module top level. The handshake has not happened yet, and the call
is dropped.

## `ctx` — the capability proxy

```ts
interface PluginActivationContext {
  readonly capabilities: PluginCapabilityCatalog
  request<T>(method: string, params?: unknown): Promise<T>

  registerTool(
    spec: PluginToolSpec,
    execute: (args: unknown, call: { callId: string }) => unknown | Promise<unknown>,
  ): Promise<void>

  registerPromptSection(id: string, content: string, order?: number): Promise<void>
}
```

### `capabilities`

A read-only snapshot of what the manifest granted:

```js
if (ctx.capabilities.fs.read.length === 0) {
  // no file access granted — do not attempt it
}
```

Use it to fail fast with a clear message instead of hitting a denied call mid-workflow.

### `registerTool(spec, execute)`

```js
await ctx.registerTool(
  {
    name: 'hello',
    description: 'Return a greeting for the given name. Use when the user asks to be greeted.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Who to greet' },
      },
      required: ['name'],
    },
    card: 'generic', // optional UI hint: generic | terminal | search | read | diff
  },
  async (args) => {
    const name = typeof args?.name === 'string' ? args.name : 'world'
    return { ok: true, value: `Hello, ${name}!` }
  },
)
```

**Tool description rules** (these decide whether the model ever calls it):

- State *when* to call it, not just what it does. "Use when the user asks to be greeted" beats
  "returns a greeting".
- State the failure semantics. If it can fail, say what the model should do next.
- Keep it under three sentences. Long descriptions crowd the prompt for every request.

`execute` receives the parsed arguments. Return `{ ok: true, value }` or
`{ ok: false, error: { code, message } }`. The value must be JSON-serializable.

### `registerPromptSection(id, content, order)`

```js
await ctx.registerPromptSection('my-rules', 'Always answer in Chinese.', 500)
```

**`content` is a static string.** It cannot depend on the session, workspace, or current time —
there is no dynamic form for third-party plugins. If the text must vary per session, the plugin
cannot do it; use an injected message through a tool result instead.

| Param | Notes |
|---|---|
| `id` | Must be listed in `contributes.promptSections` |
| `content` | Plain text; markdown is allowed |
| `order` | Lower runs earlier in the system prompt. Base prompt is `0`; runtime context `900`; time `999`. |

Pick an `order` above 100 so your text lands after the persona and tool rules.

### `request(method, params)`

Escape hatch for methods not covered by the typed helpers. Prefer the typed methods; this exists so
a newer host method is reachable without an SDK bump. Unknown methods reject.

## Registration timing and lifetime

All registrations are tied to the plugin's activation. When the plugin is unloaded:

- its tools disappear from the registry,
- its prompt sections are removed,
- its listeners stop firing.

There is a brief gap during reload where lookups may miss — the host does not serve stale entries.

## Disposers

`registerTool` and `registerPromptSection` return nothing to dispose: the host owns their lifetime.
Your own resources (timers, child processes, file watchers) are yours to clean up:

```js
export async function activate(ctx) {
  const timer = setInterval(() => { /* ... */ }, 60_000)
  return () => clearInterval(timer)
}
```

A disposer that throws is logged and skipped — it does not block the other disposers. Do not rely
on cleanup order between separate resources; if order matters, clean up both inside one disposer.

## Errors

Throw from `activate` to fail activation. The host reports:

```
Plugin acme.hello-tool failed to activate: <your message>
```

The user sees this in the plugin list. A vague message ("failed") is worse than no message — say
what was expected and what was found.

## What the plugin cannot do

| Not available | Why |
|---|---|
| Dynamic per-session prompt sections | The protocol only carries a static string |
| Depend on another plugin's service | No cross-plugin dependency in the current protocol |
| Call host `ctx` methods directly | The proxy exposes only the capabilities above |
| Synchronous host queries | Every host call is async RPC |
