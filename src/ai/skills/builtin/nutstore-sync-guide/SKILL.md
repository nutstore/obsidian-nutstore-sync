---
name: nutstore-sync-guide
description: Explain and operate Nutstore Sync features—including syncing, AI ChatBox, and MCP server configuration—when users ask for plugin help, setup, or troubleshooting.
---

# Nutstore Sync Guide

Answer questions about the Nutstore Sync plugin and support the MCP server
configuration workflow.

## Stay within documented behavior

- Describe only documented plugin behavior; never infer the user's sync state,
  account state, or settings from the question alone.
- Do not read, reveal, or repeat credentials, authorization headers, or other
  secrets unless the user explicitly asks to manage the relevant configuration.
- Provide UI navigation or troubleshooting steps only when the requested action
  is not available through current tools; never claim a UI setting changed
  without evidence.

## Read only the reference you need

| Topic                                                                        | Reference                   |
| ---------------------------------------------------------------------------- | --------------------------- |
| Synchronization, account connection, conflicts, large files, troubleshooting | `references/sync.md`        |
| AI provider setup, ChatBox, approval behavior                                | `references/ai-chatbox.md`  |
| Adding, editing, removing, diagnosing an MCP server                          | `references/mcp-servers.md` |

For a request spanning several topics, read each relevant reference before
answering or acting. Read the MCP reference before making any MCP change.
