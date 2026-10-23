---
name: app-builder
description: Create and modify interactive Apps, including games, visual tools, and persistent utilities.
---

# App Builder

Apps are real directories in the vault at `.agents/nutstore-sync/apps/<appId>/`.
Each App owns its source files and its business data independently of chat
transcripts. In bash tools the same tree is mounted at
`/.agents/nutstore-sync/apps/<appId>/...`; use the normal file tools (`ls`,
`cat`, `write`, `apply_patch`, `rm`, `mv`) to inspect and edit it.

## Create an App

Choose a stable lowercase reverse-domain App ID, like a Java package name:
`my.tool` or `notes.daily`. IDs contain two or more dot-separated segments;
each starts with `a-z` and continues with `a-z`, digits or underscores; maximum
100 characters. The ID is the directory name — dots belong to the name rather
than creating nested folders — and it is the App's identity. Keep it unchanged;
the manifest has no id field. List the Apps root to avoid collisions, and edit
an existing App only when that is the requested target.

Create the App directory and add `manifest.json` — a directory containing this
file is an App:

```json
{
	"schemaVersion": 1,
	"title": "Counter 计数 🌿",
	"iconSvg": "<svg viewBox=\"0 0 100 100\"><circle cx=\"50\" cy=\"50\" r=\"36\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"8\"/></svg>",
	"dataVersion": 1
}
```

- `schemaVersion` is `1`.
- `title` is the display name and must be non-empty.
- `iconSvg` must be inert monochrome SVG geometry with `viewBox` exactly
  `0 0 100 100`. Use only `svg`, `g`, `path`, `circle`, `ellipse`, `rect`,
  `line`, `polyline` and `polygon`; `fill` and `stroke` may only be
  `currentColor` or `none`. No text, style, URL, script, `foreignObject` or
  `<defs>` content.
- `dataVersion` is the version of the App's KV data contract. It is currently
  `1`; keep it and keep stored data compatible when upgrading code.

Never put HTML, CSS or JavaScript code in `manifest.json`.

Add `index.html` as the entry document. It may be absent or empty at first; the
App view then shows a placeholder until content exists. Other source files can
live anywhere in the App directory, including nested paths such as
`styles.css`, `app.js`, `js/main.js` or `assets/logo.svg`.

Creating an App does not open it automatically. After creating one, run
`app open <appId>` in a later bash call unless the user asked you not to open it
or requested a different outcome.

## Host-owned files

Three files at the App directory root are owned by the host and read-only for
the agent: `data.json` (the App's key-value data), `logs.jsonl` (runtime
diagnostics) and `state.json` (pin flag and timestamps). Writing, renaming or
deleting them fails, so never write them from bash and never ask the user to
edit or delete them by hand. Delete an App through the plugin UI only; do not
remove its directory from bash.

## Resource assembly

`index.html` may reference real files in its App directory using relative paths
only; a relative path resolves against the file that contains the reference. At
mount time the host reads and inlines the files so the App stays
self-contained:

- `<link rel="stylesheet" href="./styles.css">` and inline `<style>` blocks.
- Classic `<script src="./app.js"></script>` and inline `<script>` blocks.
- Image, audio and video sources: `<img src>`, `<audio src>`, `<video src>`,
  `<video poster>` and `<source src>`.
- CSS `@import "./x.css";` (without media conditions) and CSS `url("./img.png")`
  or `url("./font.woff2")` for image, font, audio and video assets.
- Files may be nested in subdirectories.

Multiple stylesheets and scripts are allowed. The host concatenates all CSS in
document order into one stylesheet and all JavaScript in document order into one
program. There is no module system, so every script shares one top-level scope
and duplicate top-level `const`/`let` names collide; the host wraps the program
in an async function, so top-level `await` is allowed. The program runs after
the markup is mounted, and native DOM, SVG and Canvas are available.

Unsupported references fail visibly instead of silently loading nothing:

- Absolute paths (`/...`), remote or protocol-relative URLs (`https://...`,
  `//...`), `..` that escapes the App directory, `<script type="module">`,
  `srcset` and `<base>` abort the mount with an error that names the containing
  file; fix the reference instead of approximating.
- Dynamic `import()`, `fetch` and `XMLHttpRequest` fail at runtime because the
  sandbox has no network.
- Multi-page navigation does not happen: `<a href="page.html">` does not change
  the view.

App source references stay inside their own directory. Read other files at runtime
through `app.fs`; network resources remain unavailable.

## Hot reload

Files are live. The host debounces any change under the App directory and
re-boots the running App view in place, so there is no separate save or build
step. A broken file or unsupported reference shows an error in the App view
until it is fixed. Because the App re-boots, in-memory state is lost; persist
anything that matters through `app.kv`.

## Startup validation and debugging

Before an App is shown, the host boots it in a hidden sandboxed iframe. If
startup fails, the App view shows the error and points to
`.agents/nutstore-sync/apps/<appId>/logs.jsonl`. Read that file from bash with
`cat /.agents/nutstore-sync/apps/<appId>/logs.jsonl` to diagnose console
output, startup errors, uncaught exceptions and unhandled rejections. It is a
host-written JSONL log and cannot be edited.

Startup validation does not exercise every interaction. Verify the main flows
manually when possible, and describe verification accurately.

## Sandbox and persistence

The App runs in an opaque-origin iframe (`sandbox="allow-scripts"`) with CSP
`default-src 'none'` and no network access. `window.app.kv` provides small JSON state. Every call is async:

- `await app.kv.get(key)` returns a JSON value or `null`; `await app.kv.list()`
  returns stored keys.
- `await app.kv.set(key, value)` and `await app.kv.delete(key)` change one key.
- `await app.kv.transact([{ key, value }, { key, delete: true }])` applies an
  atomic batch of up to 100 changes.

Values must be JSON (no functions, cycles or non-finite numbers); each value may
be at most 256 KiB and all data at most 1 MiB. Writes resolve after durable
storage, so handle failures in the interface. Initialize defaults only when keys
are absent and never clear or replace business data at startup. Save meaningful
user actions, not animation frames. `data.json` is the stored form of this data;
do not read or write it directly — use `app.kv`.

Use `addEventListener` for events; inline `on*` handler attributes are removed.
Browser storage and parent-window access are unavailable.

## AI inside an App

`app.ai` is a host-backed subset of AI SDK semantics. Do not import `ai`, load
an SDK from a CDN, ask for API keys or call a provider directly. Model credentials
stay in the host. `createAgent()` snapshots configuration; it creates no chat
session or implicit memory. Each call uses the host's configured default model,
unless `model: { providerId, modelId }` selects an existing configured model.

```js
const assistant = app.ai.createAgent({
	instructions: 'Help the user explore this application.',
})
let history = []
async function ask(text, signal) {
	const messages = [...history, { role: 'user', content: text }]
	const result = await assistant.generate({ messages, abortSignal: signal })
	history = [...messages, ...result.responseMessages]
	return result.text
}
```

`generate({ prompt })` and `generate({ messages })` return
`{ text, output?, responseMessages, finishReason, usage }`. Supply exactly one
of `prompt` and `messages`. `responseMessages` contains only messages generated
by this call, including paired tool calls/results; append it once to your input
history. `text` is the final step's text, and `usage` totals all steps. Keep
history explicitly in App state; `app.kv` can persist it subject to its existing
size limits. Instructions belong in `instructions`, not in a system message.

Messages support user text/string or text parts, assistant text/reasoning/tool-call
parts, and tool-result parts with JSON/text/error outputs. Images, attachments,
URLs, provider configuration and provider-specific content are outside this subset.
Returned message parts may contain JSON `providerOptions` with reasoning signatures
or continuation identifiers. Preserve them unchanged when replaying history;
they are model response data, not the host's API credentials or request settings.
No main-chat history, memory or built-in Agent tools are implicitly attached.

```js
const controller = new AbortController()
const result = await assistant.stream({
	prompt: 'Describe the current scene.',
	abortSignal: controller.signal,
})
for await (const text of result.textStream) appendAnswer(text)
const finalText = await result.text
const generatedMessages = await result.responseMessages
// A Stop button can call controller.abort().
```

`stream()` starts one run and returns `textStream`, `stream` and promises for
the same final result fields. Both streams observe that run without repeating
inference. Final results settle even when no stream is consumed. `stream`
preserves SDK event names and IDs for text, reasoning, tool input/call/result/error,
step start/finish and run start/finish. Provider metadata and raw errors are omitted.
Failures reject the final promises and stream iterators; partial text is not a
completed answer. Breaking an iterator does not cancel inference; abort explicitly.

For structured output, use a plain JSON Schema (draft 2020-12 by default) with
an object root. The host validates tool inputs and structured outputs, including
constraints such as `enum`, `required`, `additionalProperties` and `uniqueItems`.
Schemas must be self-contained; external references are not fetched. Unsupported
or invalid schema operations fail rather than granting additional capabilities.

```js
const player = app.ai.createAgent({
	instructions: 'Select one legal move from the supplied position.',
	output: app.ai.Output.object({
		schema: {
			type: 'object',
			properties: { move: { type: 'string', enum: ['left', 'right'] } },
			required: ['move'],
			additionalProperties: false,
		},
	}),
})
const result = await player.generate({ prompt: JSON.stringify(position) })
// Recheck the current position and business rules before applying result.output.move.
```

`tools` use `{ description, inputSchema, execute }`. Tool names use ASCII letters,
digits, `_` or `-`, start with a letter or `_`, and have at most 64 characters.
`inputSchema` is a plain JSON Schema with an object root. `execute` stays inside
the App, receives `(input, { toolCallId, abortSignal })`, and returns JSON (use
`null` for no value). The SDK runs the tool loop in the host; never implement a
second model/tool loop in App code. Tool failures become tool-error results the
model can respond to. Validate business invariants in each tool, honor cancellation,
and use `toolCallId` for deduplication when performing a mutation. File operations
inside tools still use `app.fs` and its permissions.

```js
const helper = app.ai.createAgent({
	stopWhen: app.ai.isStepCount(8),
	tools: {
		listItems: {
			description: 'Read the current items.',
			inputSchema: {
				type: 'object',
				properties: {},
				additionalProperties: false,
			},
			async execute() {
				return (await app.kv.get('items')) ?? []
			},
		},
	},
})
```

The host allows at most 4 simultaneous runs per App runtime and 8 across Apps,
20 steps (a smaller limit can use `app.ai.isStepCount(n)`), 64 tools and 64 pending
tool calls per run. `maxOutputTokens` may lower the 16,384-token host ceiling;
the configured model's lower output limit also applies. A run times out after
180 seconds, and a tool after 30 seconds. Requests are limited to 1 MiB, streamed
events and final results each to 2 MiB, tool inputs/results and structured output
to 256 KiB. A step limit preserves the SDK's `finishReason` (often `tool-calls`);
it does not guarantee a final natural-language answer. No automatic retries occur.

Errors expose a stable `code`: `INVALID_REQUEST`, `MODEL_UNAVAILABLE`,
`UNSUPPORTED_CAPABILITY`, `INVALID_OUTPUT`, `LIMIT_EXCEEDED`, `CANCELLED`,
`AI_UNAVAILABLE_IN_VALIDATION` or `AI_FAILED`. Cancellation has name `AbortError`.
App reload/closure and disabling the AI module cancel pending runs. Completed
mutations are not rolled back; late tool results cannot resume a cancelled run.

Hidden startup validation disables AI with `AI_UNAVAILABLE_IN_VALIDATION`.
Initialize the interface before inference and trigger AI from user interactions;
startup must not depend on a model response. Catch failures and show a useful
retry/stop state in the interface.

## Virtual filesystem

`app.fs` accesses the same virtual filesystem as Agent file tools. Relative
paths resolve from `/`, not the App source directory. `/` is the vault base;
`/.agents/nutstore-sync/builtin-skills` is a read-only mount. The App view
currently has no virtual settings mount.

All methods return promises, including `resolvePath`:

- `exists(path)`, `stat(path)`, `readdir(path)` (entry names).
- `readFile(path, encoding?)` for text; default UTF-8.
- `readFileBuffer(path)` returns `Uint8Array` without text conversion.
- `writeFile(path, textOrUint8Array, encoding?)`, `appendFile(...)`.
- `mkdir(path, { recursive? }?)`, `rm(path, { recursive?, force? }?)`.
- `mv(src, dest)`, `cp(src, dest, { recursive? }?)`.
- `resolvePath(base, path)` resolves a virtual path.

Encodings are `utf8`, `utf-8`, `base64`, `hex`, `binary` and `latin1`, supplied
as a string or `{ encoding }`. Write payloads are limited to 4 MiB for bytes
or 4,194,304 UTF-16 code units for strings. Filesystem errors reject the promise.
App source and host-owned files are read-only to a running App; use `app.kv`
for App state. An App may uninstall a different App by removing that App's root
directory with `{ recursive: true }`. This always asks the user and the host
removes the whole App lifecycle. An App cannot uninstall itself. Ordinary file
mutations use the host's existing permission dialog. Permissions apply to the
App independently of the authoring chat.

Startup validation permits filesystem reads only. Perform filesystem mutations in response to
user actions after startup; handle errors in the UI. Reads and writes share
Agent mount routing and encoding semantics. App closure or replacement revokes
access, including queued requests.

```js
const entries = await app.fs.readdir('/Notes')
const text = await app.fs.readFile('/Notes/Example.md')
document.querySelector('button').addEventListener('click', async () => {
	await app.fs.writeFile('/Notes/Example.md', text + '\nNew entry')
})
```

## Theme and appearance

Style the App with the active Obsidian theme tokens instead of hard-coded
chrome. At `:root` the sandbox exposes tokens including `--font-interface`,
`--font-text`, `--font-monospace`, `--font-ui-*`, `--text-normal`,
`--text-muted`, `--text-faint`, `--text-accent`, `--background-primary`,
`--background-primary-alt`, `--background-secondary`,
`--background-modifier-border`, `--background-modifier-hover`,
`--background-modifier-form-field`, `--interactive-normal`,
`--interactive-hover`, `--interactive-accent`, `--interactive-accent-hover`,
`--link-color`, semantic `--color-*` values, `--radius-*`, `--shadow-*` and
`--code-*` tokens. Use `var(--token, fallback)` with sensible fallbacks,
interface fonts for controls and text fonts for reading content. The iframe's
`color-scheme` follows Obsidian and token values update live after a theme
change, so do not cache them at startup. Only design-token values are shared;
Obsidian component class styles are not available.

## Edit efficiently

Read `manifest.json` and the relevant source files before modifying an existing
App. Reads are cheap, but every save hot-reloads the App, so prefer targeted
edits over rewriting the whole App on every tool call. Keep `index.html`
references in sync with files that actually exist, and update the code together
with its stored-data contract.

## Commands

- `app open [appId]` — opens the App view; with no argument it opens the
  currently selected App.

## Deliver usable behavior

Utilities need editing and persistence where appropriate; games need input,
scoring, restart and touch controls. Design from 320px mobile widths, allow long
Chinese, English text and Emoji to wrap, use controls at least 44px and input
text at least 16px. Avoid hover-only interactions. Match the user's language and
requested visual character.
