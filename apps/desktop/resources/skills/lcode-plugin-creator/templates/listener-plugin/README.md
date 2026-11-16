# Session Logger

A minimal Lcode plugin template that listens to session events and holds a long-lived resource.

## What it does

Registers a listener for `session/end` and runs a periodic flush timer. It exists mainly to show
**disposer discipline**: the timer is created in `activate` and cleared in the returned disposer.

## Install

```sh
mkdir -p ~/.lcode/plugins/acme.session-logger
cp -r ./* ~/.lcode/plugins/acme.session-logger/
```

## Permissions

None — the template only writes to stderr (captured by the host log).

## Lazy activation

`lcode.json` declares:

```json
"activation": { "events": ["session/end"] }
```

The plugin stays dormant until one of these events fires. Every event you listen to must be listed
here, or the listener registration is rejected.

Omit `activation` entirely if the plugin must be active from startup.

## The disposer is the point

```js
const timer = setInterval(tick, 30_000)
timer.unref?.()
return () => clearInterval(timer)
```

Two details that matter:

| Detail | Why |
|---|---|
| `timer.unref()` | An active timer keeps the Node event loop alive; the plugin process then refuses to exit cleanly |
| `clearInterval` in the disposer | Without it, the timer keeps firing after the plugin is unloaded — it survives until the process is killed |

Everything you create needs a matching cleanup: timers, child processes, file watchers, sockets.

## Cleanup order

Disposers of separate resources run concurrently, not in a fixed order. If two resources must be
released in a particular sequence, release both inside **one** disposer.

A disposer that throws is logged and skipped — it does not stop the others, but that resource is
then leaked silently.

## Customize

Replace the `setInterval` body with your own work. If you need to touch the filesystem or network,
add the corresponding entries to `permissions` in `lcode.json` first — the capability layer denies
anything undeclared.
