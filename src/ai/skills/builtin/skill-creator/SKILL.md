---
name: skill-creator
description: Create and define agent Skills in the current Obsidian vault. Use when the user asks to create a Skill, write a SKILL.md file, or turn a workflow into reusable agent instructions.
---

# Skill Creator

Create reusable Skills for the agent.

## Understand Skills

A Skill is a self-contained directory of instructions that teaches the agent
how to perform a particular kind of task. Skills use progressive disclosure:

1. The agent first sees only the Skill name, description, and path.
2. When a task matches, the agent reads the full `SKILL.md`.
3. Supporting files are accessed later only when needed.

A Skill provides knowledge and workflow instructions. It does not grant new
permissions, bypass safeguards, or require a particular tool.

## Create the required structure

Create each Vault Skill at:

```text
.agents/skills/<skill-name>/SKILL.md
```

The directory name and frontmatter `name` must match exactly. Every Skill
requires YAML frontmatter followed by Markdown instructions:

```markdown
---
name: example-skill
description: Explain what this Skill does and when the agent should use it.
---

# Example Skill

Follow the workflow described here.
```

## Choose the name

Choose a short, action-oriented name that:

- Contains only lowercase ASCII letters, digits, and single hyphens.
- Starts and ends with a letter or digit.
- Is no longer than 64 characters.
- Exactly matches its directory name.

## Write the description

Treat `description` as the triggering contract. State both what the Skill does
and when it should be used. Keep it specific enough to distinguish the Skill
from unrelated tasks. The description must be non-empty and no longer than
1024 characters.

Do not put essential triggering conditions only in the body because the body is
not loaded until after the Skill has been selected.

## Write effective instructions

Assume the agent is already capable. Include only specialized, procedural,
project-specific, or easy-to-miss information. Write direct, actionable
instructions and prefer concise workflows or examples over broad explanations.

Match detail to the task: give flexible guidance when several approaches are
valid, ordered steps when sequence matters, and exact commands or scripts only
when deterministic behavior is required.

Do not unnecessarily restrict which tools the agent may use. Let it choose from
the tools available in its environment unless a particular integration is an
essential part of the Skill.

## Add optional resources only when useful

```text
skill-name/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

- Use `scripts/` for repeatable deterministic operations.
- Use `references/` for detailed knowledge loaded only when needed.
- Use `assets/` for templates and files used in generated output.

Supporting files are not automatically loaded. Reference them clearly from
`SKILL.md` and explain when to read or use them. Avoid unrelated files such as
README files, changelogs, or installation guides.

## Follow the creation workflow

1. Determine the intended task and representative user requests.
2. Choose and validate the Skill name.
3. Check whether the target directory already exists.
4. Plan the minimum required instructions and supporting resources.
5. Create the directory and `SKILL.md` with any suitable available tools.
6. Add optional resources only when they provide reusable value.
7. Read the resulting files and verify their structure and content.
8. Report the created path and briefly describe when the Skill will trigger.

Do not overwrite an existing Skill without making the conflict clear to the
user.

## Validate the result

Verify that:

- The file is at `.agents/skills/<name>/SKILL.md`.
- The directory and frontmatter names match.
- `name` and `description` are present and valid.
- The body contains actionable instructions.
- Every referenced supporting file exists.
- `SKILL.md` is UTF-8 text, contains no null bytes, and is smaller than 64 KiB.
