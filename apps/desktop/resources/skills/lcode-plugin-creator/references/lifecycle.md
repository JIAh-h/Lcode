# Plugin lifecycle

How a plugin goes from a folder on disk to a registered capability, and what happens on the way
down. Understanding this prevents the two most common failures: registering too early, and
resources outliving the plugin.

## States

```
discovered → validated → activating → active → deactivating → disposed
                              ↓
                           failed
```

| State | Meaning | What you can do |
|---|---|---|
| `discovered` | Manifest found on disk | — |
| `validated` | Manifest parsed and schema-checked | Nothing yet; entry not loaded |
| `activating` | `activate()` is running | Awaiting your registration calls |
| `active` | Activation returned | Your tools/sections are live |
| `deactivating` | Disposer is running | — |
| `disposed` | Process released | — |
| `failed` | Activation threw, or the process died | Host reports the reason to the user |

**A plugin is only useful in `active`.** Registration calls made before `activating` are dropped;
calls made after `disposed` reject.

## Activation sequence

```
1. Host reads lcode.json → validates against the schema
2. Host spawns the utility process
3. Plugin loads its entry module (top-level code runs HERE)
4. Handshake: host sends capabilities snapshot
5. Host calls activate(ctx, config)
   ├─ your registerTool / registerPromptSection calls become live
   └─ any thrown error → state becomes `failed`, everything rolled back
6. Plugin becomes `active`
```

Step 3 matters: top-level code runs **before** the handshake, so `ctx` is not usable there. Only
`activate` receives a working `ctx`.

## Deactivation sequence

```
1. Host calls deactivate() (if exported) and awaits it
2. Host runs the disposer returned by activate()
3. Host removes your tools / prompt sections from the registry
4. Host terminates the utility process
```

Order means: during step 2 your tools are still registered but may not be called. Do not start new
work in a disposer.

The host terminates the process even if your disposer hangs — but your `deactivate` may not complete,
so keep cleanup fast. A disposer that never settles stalls teardown until the kill.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `failed to activate: Cannot read properties of undefined` | Used `ctx` at top level | Move registration into `activate` |
| `Tool x is not declared in the plugin manifest` | Missing entry in `contributes.tools` | Declare it |
| `Plugin registered invalid tool definition` | Bad `inputSchema` shape | Schema must be `{type:'object',properties:{...}}` |
| Plugin listed but tool never appears | Registration threw silently, or `contributes` mismatch | Check the plugin log |
| Tool appears but model never calls it | Description does not say *when* to use it | Rewrite the description |
| Activation succeeds, then nothing works | Process crashed after activation | Check the log; an unhandled rejection kills the plugin |

## Logs

Plugin stderr is captured to the host log. Prefix your messages so they are findable:

```js
console.error('[acme.hello-tool] unexpected config:', config)
```

## Reload and restart boundaries

| Change | Takes effect |
|---|---|
| Tool/preload-section content | On plugin reload |
| `lcode.json` (any field) | Requires restart |
| Adding or removing a plugin | Requires restart |
| Host version change | Re-check `engines.lcode` |

Do not assume hot reload during development — restart to be sure. A plugin that "works" only after
reload is a plugin with a top-level side effect that will bite in production.

## Resource ownership

Everything you create is yours until you destroy it:

| Resource | Who cleans up |
|---|---|
| Tool / prompt section | Host (removed on deactivate) |
| Timer, interval | **You** (disposer) |
| Child process | **You** |
| File handle, watcher | **You** |
| In-memory state | Gone with the process; do not assume it persists |

If the plugin needs state across restarts, write it to a file under a path declared in
`permissions.fs.write`. Do not rely on module-level variables surviving.
