# AI ChatBox

The plugin includes an AI Agent that can read, edit, and manage vault files
through natural-language requests. It supports compatible AI providers and
can carry out multi-step tasks with the tools available in the current chat.

## Approval behavior

Before making a change, the agent requests approval by default. The user can
approve an individual operation, approve an operation type for the current
session, or enable YOLO mode in settings to auto-approve operations.

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
