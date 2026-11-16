# Verification

A plugin that typechecks is not a plugin that loads. Work through this list in order — each step
catches a different class of failure, and later steps assume earlier ones passed.

## 1. Manifest parses and validates

```sh
node -e "JSON.parse(require('fs').readFileSync('lcode.json','utf8')); console.log('json ok')"
```

Then check by eye (the schema is closed — unknown fields reject):

- [ ] `id` matches `^[a-z0-9]+(?:[.-][a-z0-9]+)+$` (at least two segments, lowercase)
- [ ] `version` is semver
- [ ] `engines.lcode` is a range the host satisfies
- [ ] `entry` is a **relative** path that exists
- [ ] `permissions` present (empty `{}` if none)
- [ ] `contributes` present

## 2. Entry loads in plain Node

```sh
node --input-type=module -e "import('file:///ABSOLUTE/PATH/src/index.js').then(m => console.log('exports:', Object.keys(m)))"
```

Expect `exports: [ 'activate' ]` (plus `deactivate` if you export it).

If this fails, the plugin will never load. Common causes: TypeScript source pointed at by `entry`,
a missing dependency, or a syntax error only the bundler accepted.

## 3. `contributes` matches registrations

Read `src/index.js` and list every `registerTool` / `registerPromptSection` call. Compare against
`lcode.json`:

```
registerTool({name:'hello'})        → contributes.tools must contain "hello"
registerPromptSection('rules', ...) → contributes.promptSections must contain "rules"
registerListener('session/end',...) → activation.events must contain "session/end"
```

A mismatch is not a warning — the host throws at activation.

## 4. Permissions cover what the code does

- [ ] Every `fs` path the plugin opens is inside `permissions.fs.read` / `.write`
- [ ] Every hostname is in `permissions.network.domains`
- [ ] Every executable is in `permissions.spawn.allow`

Start empty and add only what you actually use. A plugin requesting `**` is one the user will refuse.

## 5. Disposers exist for everything you created

Grep your entry for `setInterval`, `setTimeout`, `spawn`, `watch`, `createServer`, `addEventListener`.
Each needs a matching cleanup in the disposer:

```js
export async function activate(ctx) {
  const timer = setInterval(tick, 1000)
  const child = spawn('long-running')
  return () => {
    clearInterval(timer)
    child.kill()
  }
}
```

## 6. Install into a scratch profile and load

```sh
# copy the plugin into a scratch install dir
mkdir -p ~/.lcode/plugins/dev-scratch
cp -r ./my-plugin ~/.lcode/plugins/dev-scratch/
```

Restart the host, then confirm:

- [ ] The plugin appears in the plugin list with state `active` (not `failed`)
- [ ] The tool appears in the model's tool list
- [ ] Its prompt section (if any) appears in the assembled system prompt
- [ ] The plugin log has no error lines
- [ ] Disabling and re-enabling it works

**This step is the only one that proves it works.** Steps 1–5 are cheap filters; step 6 is the
real test.

## 7. Exercise the tool

Ask the model to use it, or call it directly if the host offers a way. Confirm:

- [ ] Success returns `{ ok: true, value }` with the shape you documented
- [ ] Failure returns `{ ok: false, error: { code, message } }` — not a thrown exception
- [ ] The model actually invokes it from the description alone (if not, rewrite the description)

## Common failures and where they hide

| Symptom | Check |
|---|---|
| Plugin `failed` immediately | Step 2 (entry loads) and top-level `ctx` use |
| Plugin `active`, no tool visible | Step 3 (`contributes`) |
| Tool visible, call errors with denial | Step 4 (permissions) |
| Tool works, then plugin dies | Unhandled rejection; check the log |
| Works locally, fails after install | Absolute paths, or a dependency not shipped |
| Works until restart, then gone | Registered at module top level instead of in `activate` |

## What not to claim

Do not report "the plugin works" from any of these alone:

- TypeScript compiles
- Unit tests pass (they do not exercise the host handshake)
- The manifest validates (it says nothing about the code)

Only step 6, plus one real tool invocation, supports the claim.
