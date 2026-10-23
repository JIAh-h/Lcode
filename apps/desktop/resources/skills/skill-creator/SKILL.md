---
name: skill-creator
description: Create or update Lcode skills as reusable SKILL.md bundles. Use when the user asks to create, edit, package, validate, or install a skill, or wants a repeatable workflow, domain knowledge, or checklists made available for later prompts.
---

# Create Lcode Skills

## Overview

A skill is a folder containing a required `SKILL.md` plus optional bundled
resources. Lcode loads only the skill name and description by default, then
loads the full `SKILL.md` when the user selects the skill. Keep the body short:
the context window is shared with the conversation and other skills.

## Workflow

### 1. Understand the job

Identify the concrete trigger and outcome. Ask at most one or two questions if a
critical detail is missing; otherwise propose a concrete plan and proceed.

Good skill ideas are repeated tasks with stable steps, domain rules, schemas,
or output conventions. Do not create a skill for a one-off request.

### 2. Plan reusable resources

- `SKILL.md` — trigger metadata and instructions.
- `scripts/` — only when a deterministic script is repeatedly rewritten or
  output must be exact. Test every script before shipping it.
- `references/` — longer documentation or schemas loaded only when needed.
- `assets/` — templates or files used to produce output; not loaded into context.

Create only the directories that are actually needed.

### 3. Choose the location

- User-level: `~/.lcode/skills/<skill-name>/`
- Project-level: `<workspace>/.lcode/skills/<skill-name>/`

Use the same hyphen-case name for the folder and the frontmatter `name`.

### 4. Write SKILL.md

Frontmatter must be the first thing in the file:

```markdown
---
name: my-skill
description: What the skill does and the exact situations that should trigger it. Keep this on one line and under 1024 characters.
---
```

Then write imperative instructions:

1. State the goal and the trigger.
2. Give the ordered steps, commands, or decision rules.
3. Name the inputs, outputs, and failure behavior.
4. Point to bundled resources only when they are needed.

Prefer concise examples over long explanations. Remove anything the agent
already knows. Do not add README, CHANGELOG, installation guides, or empty
placeholder directories. Keep the body under 500 lines; move detailed material
into `references/` and tell the agent when to read it.

### 5. Validate

- `SKILL.md` exists and frontmatter starts and ends with `---`.
- `name` is lowercase hyphen-case and matches the folder name.
- `description` is one line, specific about triggers, and ≤ 1024 characters.
- No unresolved placeholder markers remain.
- The body is under 500 lines.
- Scripts were actually run and produce clear, bounded output.
- No extraneous documentation files.

### 6. Install and test

For a user-level skill, make sure this file exists:

`~/.lcode/skills/<skill-name>/SKILL.md`

Lcode rescans the skill directory when the composer's `+ → Skills` panel is
opened. Select the skill there and send a prompt that should trigger it. If the
skill is packaged as a zip, the user can import it from
`Settings → Extensions → Skills`.

If the skill is intended for a project, write it under
`<workspace>/.lcode/skills/<skill-name>/` and commit it with the project when
appropriate.

## Updating a skill

Read the existing `SKILL.md` first. Preserve working behavior, change only what
the new requirement needs, and re-run the validation checklist. Do not rename
the folder unless the frontmatter name is changed too.
