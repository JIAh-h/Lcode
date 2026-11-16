# House Rules

A minimal Lcode plugin template that injects standing instructions into every session.

## What it does

Registers a prompt section containing text the model sees on every request — house style, output
conventions, language preference. The text is configurable through the plugin's settings.

## Install

```sh
mkdir -p ~/.lcode/plugins/acme.house-rules
cp -r ./* ~/.lcode/plugins/acme.house-rules/
```

Restart Lcode, then set the `rules` value in the plugin's configuration.

## Permissions

None.

## Important limitation

The section content is a **static string**. It cannot depend on the session, the workspace, or the
current time — Lcode's plugin protocol only carries a string for prompt sections. If the text must
change per session, do not use this template; deliver the text through a tool result instead.

## Choosing an order

| `order` | Lands |
|---|---|
| `0` | Before the base persona |
| `100`–`800` | After the persona and tool rules — **use this range** |
| `900` | Interleaved with runtime context (time, repo map) |
| `999` | At the very end of the system prompt |

Lower runs earlier. Putting text at the very start or very end changes how strongly the model
weights it, and placing it after `900` risks it being treated as ambient data rather than rules.

## Keep it short

Every character here is paid on every request. A few lines of rules are fine; a page of style
guide is not — move long reference material into a skill instead.
