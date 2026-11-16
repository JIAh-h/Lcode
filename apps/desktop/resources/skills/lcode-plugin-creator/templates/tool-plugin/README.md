# Hello Tool

A minimal Lcode plugin template that adds one tool the model can call.

## What it does

Registers a `hello` tool that returns a greeting. It demonstrates the four rules a plugin must
satisfy to load (declared contribution, registration inside `activate`, disposer discipline, plain
ESM entry).

## Install

```sh
mkdir -p ~/.lcode/plugins/acme.hello-tool
cp -r ./* ~/.lcode/plugins/acme.hello-tool/
```

Restart Lcode. The plugin should appear in the plugin list as `active`, and `hello` should appear
in the model's tool list.

## Permissions

None. The template declares `"permissions": {}` and does not touch the filesystem, network, or
child processes.

## Customize

1. Change `id` in `lcode.json` to your own (lowercase, dot-separated, at least two segments).
2. Change the tool `name` in both `lcode.json` → `contributes.tools` and the `registerTool` call.
3. Rewrite the tool `description` to say **when** the model should call it.
4. Replace the body of the `execute` function.

## Known limits

- The tool result must be JSON-serializable.
- A description that does not say when to call it means the model will rarely use it.
