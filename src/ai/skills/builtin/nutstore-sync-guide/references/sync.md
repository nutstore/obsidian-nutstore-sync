# Synchronization Guide

Nutstore Sync synchronizes an Obsidian vault and Nutstore through WebDAV. It
uses incremental synchronization after it has synchronization history, so the
first run can take longer than later runs.

## Before recommending a change

Ask which side is the source of truth, whether the device should be allowed to
upload, and whether the user needs an exact mirror or wants to preserve unique
files on both sides. Do not infer the current policy, conflict strategy, or
sync result from the question alone.

Recommend a backup before a first sync, a policy that can delete files, or an
automatic merge of important notes. Prefer a manual, confirmed sync when
testing a new policy or resolving a conflict.

## Sync policies

The sync policy is chosen per device. It controls the direction of file
changes; excluded files, files over the configured size limit, and protected
plugin files are exceptions to the normal rules.

### Two Way

Use this as the normal multi-device policy. New files, edits, and deletions are
propagated in both directions.

- A change on only one side is copied to the other side.
- If a deletion meets an edit on the other side, the edited copy is retained
  and restored rather than being deleted.
- If both sides edit the same file, the configured conflict strategy decides
  the result.

### Send Only

Use this when the local vault is normally authoritative and the cloud should
not introduce changes back into the device.

- Local new or edited files upload to the cloud.
- A local deletion removes the cloud copy only when that cloud copy has not
  changed independently.
- Cloud-only files and cloud edits are preserved instead of being downloaded
  or overwritten.
- When both copies have changed, the item is skipped to protect the cloud
  edit; this policy does not run the conflict resolver.

### Send Only: Override Changes

Use only when the cloud must be made to match the current local vault.

- Local files replace cloud files with the same path.
- Cloud files that do not exist locally are removed.
- Back up first and review pending operations, because this mode can delete
  cloud-only content.

### Receive Only

Use this for a device that should follow the cloud while preserving its unique
local work.

- Cloud new or edited files download to the local vault.
- A cloud deletion removes a local copy only when that local copy has not
  changed independently.
- Local-only files and local edits are preserved instead of being uploaded or
  overwritten.
- When both copies have changed, the item is skipped to protect the local
  edit; this policy does not run the conflict resolver.
- The plugin never deletes its own files (the `plugins/nutstore-sync/` folder
  inside the Obsidian config directory). When the remote vault does not have
  the plugin installed, those local files are preserved, even in Revert mode.

### Receive Only: Revert Local Changes

Use only when the local vault must be made to match the cloud.

- Cloud files replace local files with the same path.
- Local files that do not exist in the cloud are removed.
- Back up first and review pending operations, because this mode can delete
  local-only content.

## Strict and loose modes

- **Strict** checks same-path files without synchronization history instead of
  assuming they are equal. In two-way sync, such a pair is handled as a
  conflict; one-way policies follow their chosen source side.
- **Loose** is the default and is faster for large vaults. If a same-path file
  has no synchronization history and both copies have the same byte size, it
  is treated as already synchronized. Their contents are not compared in that
  case.

Use strict mode when correctness matters more than speed, especially after
copying files independently to both locations. Use loose mode only when equal
sizes are an acceptable shortcut.

## Conflict resolution

A two-way file conflict occurs when both copies changed since their last
known common state. The selected strategy applies to that file.

| Strategy            | User-visible result                                                                                                                                                               | Use when                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Conflict-free merge | Attempts to produce one merged text file without conflict markers. For JSON, independent object fields can be combined; competing changes to the same value keep the local value. | Both sides contain meaningful text edits and the user will review the result. |
| Diff3 merge         | Writes Git-style `<<<<<<<`, `=======`, and `>>>>>>>` markers for overlapping edits.                                                                                               | The user wants to inspect and decide every overlap.                           |
| Local priority      | Replaces the cloud copy with the local file.                                                                                                                                      | The local file is unquestionably correct.                                     |
| Server priority     | Replaces the local copy with the cloud file.                                                                                                                                      | The cloud file is unquestionably correct.                                     |

Conflict-free merge runs a fallback chain on text files:

1. If both copies are identical, nothing changes.
2. For JSON files, fields are merged one by one: independent fields are
   combined, and a field changed on both sides keeps the local value.
3. Otherwise a Git-style diff3 merge runs; if no hunks overlap, its clean
   merge is used directly.
4. If diff3 reports overlapping edits, a collaborative-editing merge (Yjs
   CRDT) reconciles both branches against the common base snapshot.
5. If that also fails, the merge is reported as failed rather than silently
   overwriting anything, leaving the file for manual handling.

The three-way merge is based on the last common base blob recorded for the
file, so repeated merges are deterministic. A successful merge is written to
both the local note and the remote copy.

Automatic text merging is available only for recognized text formats, including
Markdown, JSON, YAML, CSV, common source/configuration files, and plain text.
It is not a safe choice for binary or unsupported file types; choose the
authoritative side instead. Files over the configured size limit are skipped,
including during conflict handling.

When using conflict-free merge, review the merged note before relying on it.
When using Diff3, resolve every marker block and make sure no markers remain.
For a Markdown file with markers, a configured AI model enables the editor's
conflict-resolution action, which opens a focused ChatBox task; it does not
silently resolve the file.

If the same path is a folder on one side and a file on the other, correct the
layout manually before retrying. Do not promise that the plugin can merge that
kind of conflict.

## Other settings that affect results

- **Confirm before sync** displays the pending operations before they run.
- **Confirm before deleting files during auto-sync** lets the user choose
  whether to delete a local file or re-upload it when automatic sync would
  remove it.
- **Real-time sync**, startup sync delay, and interval sync control when a
  sync starts; they do not change the selected policy.
- **Skip large files** omits files above the configured limit from sync tasks.
  Lower the limit if large files are causing reliability problems, but explain
  that skipped files will remain unsynchronized.
- Configuration-directory sync can exclude the whole Obsidian configuration
  directory, include only bookmarks, or include it more broadly. Some plugin
  runtime data remains excluded even when configuration sync is enabled.
- Inclusion and exclusion filters apply before reconciliation. Do not tell a
  user that an excluded path will be synchronized.

## Troubleshooting workflow

1. Ask whether the issue is a missing file, an unexpected overwrite, a skipped
   item, a conflict marker, or a connection/error message.
2. Confirm the intended source of truth and the active policy before proposing
   an override or revert policy.
3. Check filters, file-size limits, and the selected strict/loose mode before
   treating an item as a conflict.
4. For a conflict, preserve copies of both versions, choose a strategy that
   matches the user's intent, then review the resulting file.
5. Ask for the visible error or a redacted log excerpt if more evidence is
   needed. Never request credentials, access tokens, or authorization headers.

Do not state that synchronization completed, failed, or used a particular
strategy unless the user provides evidence from the progress UI or logs.
