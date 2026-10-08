# AI ChatBox

The plugin includes an AI Agent that can read, edit, and manage vault files
through natural-language requests. It supports compatible AI providers and
can carry out multi-step tasks with the tools available in the current chat.

## Approval behavior

Before making a change, the agent requests approval by default. The user can
approve an individual operation, approve an operation type for the current
session, or enable YOLO mode in settings to auto-approve operations.

## Memory

When memory is enabled in the AI settings (it is by default), the agent
remembers the user's preferences, conventions, decisions, and ongoing work
across sessions. It records what it learns on its own, without asking first,
and also follows explicit requests.
Everything it remembers lives in one Markdown file, `.agents/nutstore-sync/MEMORY.md` in
the plugin directory. Configured memory paths must stay inside that directory. Each top-level list item
is one memory; anything else in the note is left untouched. The note is
created the first time something is remembered.

- The user can also ask the agent to remember, correct, or forget something
  in plain language. Memory changes never wait for approval; instead each one
  appears in the chat and can be undone by recalling the message with its
  changes restored.
- The user can view and edit memory from the AI settings or with the **Edit AI
  memory** command. The file is stored in the hidden plugin directory.
- The agent reads the current memory file before each user message.

## Run HTML in chat

When the agent's reply contains an HTML code block, the chat shows a Run
toggle that renders the code in a sandboxed preview pane inside the message
(scripts, forms, and popups are allowed, but the pane is sandboxed). Use it
to preview generated pages, UI prototypes, or widgets without leaving
Obsidian.

## Sessions are files

Chat sessions persist as individual JSON files in the vault:

```text
.agents/nutstore-sync/
├── chat-meta.json              # lightweight index of sessions and titles
└── sessions/<id>.json           # one full ChatSession per file
```

Each session file holds its title alongside the snapshot, so the index can
always be rebuilt from the files. Because sessions are plain vault files,
they are grep-able and sync across devices with the same sync feature.
Context can be compressed manually or automatically, and a message can be
recalled, optionally restoring the file changes it made.

Do not say a provider, model, or approval setting is configured unless the
user supplies that information or it is available in the current workspace.
