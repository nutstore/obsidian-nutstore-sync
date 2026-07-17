import { idAgent } from 'id-agent'
import { InMemoryFs, type IFileSystem } from 'just-bash/browser'
import { App, normalizePath, TFile } from 'obsidian'
import { posix as pathPosix } from 'path-browserify'
import { tool, type ToolExecutionOptions, type ToolSet } from 'ai'
import { z } from 'zod/mini'
import { getMasterAgent } from '~/ai/chat/domain'
import { getWorkspaceContextDeltas } from '~/ai/chat/messages/ui-message'
import { createCompressedFileContent } from '~/ai/chat/messages/reversible-content'
import type { AppToolContext } from '~/ai/core/types'
import {
	BUILTIN_SKILLS_MOUNT_POINT,
	execVaultBash,
	VAULT_MOUNT_POINT,
} from '~/ai/tools/bash/runtime'
import { buildNoteNeighborhood } from '~/ai/tools/note-neighborhood'
import {
	executeTodoWrite,
	todoWriteInputSchema,
	type TodoWriteInput,
} from '~/ai/tools/todowrite'
import { chatTodoItemSchema } from '~/ai/chat/types'
import i18n from '~/i18n'
import type { PermissionGuard } from './permission-guard'
import { findAgent } from '~/ai/chat/agents/agent-tree'
import { writeBashTmpText } from '~/ai/tools/bash/tmp-fs'
import {
	createTaskTool,
	type DispatchTaskParams,
	type DispatchTaskResult,
} from '~/ai/tools/task'

interface ReplaceResult {
	content: string
	matchCount: number
}

const textValue = (field: string) =>
	z.string({
		error: () => i18n.t('chatbox.errors.toolFieldRequired', { field }),
	})

const booleanValue = (field: string) =>
	z.pipe(
		z.transform((value: unknown) => {
			if (typeof value === 'boolean') {
				return value
			}
			if (typeof value === 'string') {
				const normalized = value.trim().toLowerCase()
				if (normalized === 'true') {
					return true
				}
				if (normalized === 'false') {
					return false
				}
			}
			return value
		}),
		z.boolean(i18n.t('chatbox.errors.toolFieldRequired', { field })),
	)

const integerValue = (field: string) =>
	z.pipe(
		z.transform((value: unknown) => {
			if (typeof value === 'number') {
				return value
			}
			if (typeof value === 'string') {
				const normalized = value.trim()
				if (normalized !== '') {
					return Number(normalized)
				}
			}
			return value
		}),
		z.int(i18n.t('chatbox.errors.toolFieldRequired', { field })),
	)

function isAllowedBashCwd(pathValue: string) {
	const normalized = pathPosix.normalize(
		pathPosix.resolve('/', pathValue || '/'),
	)
	return (
		normalized === '/' ||
		normalized === BUILTIN_SKILLS_MOUNT_POINT ||
		normalized.startsWith(`${BUILTIN_SKILLS_MOUNT_POINT}/`) ||
		normalized === VAULT_MOUNT_POINT ||
		normalized.startsWith(`${VAULT_MOUNT_POINT}/`)
	)
}

interface CreateAIToolsOptions {
	dispatchTask?: (params: DispatchTaskParams) => Promise<DispatchTaskResult>
	dispatchableDefinitions?: readonly import('~/ai/chat/agents/registry').AgentDefinition[]
	allowSpawn?: boolean
	permissionGuard?: PermissionGuard
	enableTodoWrite?: boolean
	bashScratch?: IFileSystem
}

const MAX_INLINE_BASH_OUTPUT_CHARS = 20 * 1024

function replaceUniqueOccurrence(
	content: string,
	oldText: string,
	newText: string,
) {
	if (oldText === '') {
		if (content !== '') {
			throw new Error(i18n.t('chatbox.errors.editMatchNotUnique'))
		}
		return {
			content: newText,
			matchCount: 1,
		} satisfies ReplaceResult
	}

	let matchIndex = content.indexOf(oldText)
	let matchCount = 0

	while (matchIndex !== -1) {
		matchCount += 1
		if (matchCount > 1) {
			break
		}
		matchIndex = content.indexOf(oldText, matchIndex + oldText.length)
	}

	if (matchCount === 0) {
		throw new Error(i18n.t('chatbox.errors.editMatchNotFound'))
	}
	if (matchCount > 1) {
		throw new Error(i18n.t('chatbox.errors.editMatchNotUnique'))
	}

	return {
		content: content.replace(oldText, newText),
		matchCount,
	} satisfies ReplaceResult
}

function resolveCurrentNotePath(context: AppToolContext) {
	const agent =
		findAgent(getMasterAgent(context.session), context.agentId) ??
		getMasterAgent(context.session)

	for (let index = agent.timeline.length - 1; index >= 0; index -= 1) {
		const activeFile = getWorkspaceContextDeltas(agent.timeline[index]).find(
			(entry) => entry.key === 'activeFile',
		)
		if (activeFile) {
			return typeof activeFile.content === 'string' ? activeFile.content : ''
		}
	}

	return ''
}

function resolveNotePath(app: App, note: string, sourcePath: string) {
	const normalizedPath = normalizePath(note)
	const direct = app.vault.getAbstractFileByPath(normalizedPath)
	if (direct instanceof TFile) {
		return direct.path
	}

	const resolved = app.metadataCache.getFirstLinkpathDest(note, sourcePath)
	if (resolved instanceof TFile) {
		return resolved.path
	}

	throw new Error(i18n.t('chatbox.errors.fileNotFound', { path: note }))
}

export function createAITools(
	app: App,
	options: CreateAIToolsOptions = {},
): ToolSet {
	const { permissionGuard } = options
	const bashScratch = options.bashScratch ?? new InMemoryFs()
	const tools: ToolSet = {
		...(options.enableTodoWrite
			? {
					todowrite: tool({
						description:
							'Create, update, query, and maintain a structured todo list for the current coding session. Use it proactively when work has more than three steps, needs planning, or the user explicitly asks for task tracking. Call without todos to query the current list. Call with the complete current todos array to save the list. Each todo contains only content, status, and priority. Status values are pending, in_progress, completed, or cancelled. Priority values are high, medium, or low. Keep exactly one active todo in in_progress when possible, update progress in real time, and do not batch-complete multiple todos at the end.',
						inputSchema: todoWriteInputSchema,
						outputSchema: z.object({ todos: z.array(chatTodoItemSchema) }),
						execute: async (
							params: TodoWriteInput,
							{ context, toolCallId }: ToolExecutionOptions<AppToolContext>,
						) => {
							const output = await executeTodoWrite(params, context.session)
							context.recordMetadata?.(toolCallId, { todos: output.todos })
							return output
						},
						toModelOutput: ({ output }) => {
							const { todos } = output
							if (!todos?.length) {
								return { type: 'text', value: 'The todo list is empty.' }
							}
							return {
								type: 'text',
								value: `Todo list:\n${todos
									.map(
										(todo) =>
											`- [${todo.status}] ${todo.content} (${todo.priority})`,
									)
									.join('\n')}`,
							}
						},
					}),
				}
			: {}),
		note_neighborhood: tool({
			description:
				'Return an Obsidian-style local knowledge graph neighborhood for a note as a simple adjacency map. Input a note path or link path plus a depth. Output includes the resolved root path, normalized depth, and adj where each key is a note path and each value is the sorted list of related note paths within the returned neighborhood.',
			inputSchema: z.object({
				note: z
					.string()
					.check(
						z.trim(),
						z.minLength(
							1,
							i18n.t('chatbox.errors.toolFieldRequired', { field: 'note' }),
						),
					),
				depth: z._default(integerValue('depth'), 1),
			}),
			outputSchema: z.object({
				root: z.string(),
				depth: z.number(),
				adj: z.record(z.string(), z.array(z.string())),
			}),
			execute: async (
				params,
				{ context }: ToolExecutionOptions<AppToolContext>,
			) => {
				const root = resolveNotePath(
					app,
					params.note,
					resolveCurrentNotePath(context),
				)
				return buildNoteNeighborhood(
					app.metadataCache.resolvedLinks ?? {},
					root,
					params.depth,
				)
			},
			toModelOutput: ({ output }) => {
				const neighborhood = output
				const entries = Object.entries(neighborhood.adj).map(
					([path, related]) =>
						`- ${path}: ${related.length ? related.join(', ') : 'no related notes'}`,
				)
				return {
					type: 'text',
					value: `Note neighborhood for ${neighborhood.root} at depth ${neighborhood.depth}:\n${entries.join('\n')}`,
				}
			},
		}),
		edit_file: tool({
			description:
				'Edit a vault text file by replacing one exact, uniquely matched text block with new text. The path can be a vault-relative path (e.g. notes/file.md) or an absolute virtual path (e.g. /vault/notes/file.md).',
			inputSchema: z.object({
				path: z
					.string()
					.check(
						z.trim(),
						z.minLength(
							1,
							i18n.t('chatbox.errors.toolFieldRequired', { field: 'path' }),
						),
					),
				oldText: z.string(),
				newText: textValue('newText'),
			}),
			outputSchema: z.object({
				replaced: z.literal(true),
			}),
			execute: async (
				params,
				{ context, toolCallId }: ToolExecutionOptions<AppToolContext>,
			) => {
				const path = params.path
				const oldText = params.oldText
				const newText = params.newText
				if (path.startsWith('/') && !path.startsWith(`${VAULT_MOUNT_POINT}/`)) {
					throw new Error(
						`edit_file can only access files inside the vault. Use a vault-relative path (e.g. notes/file.md) or an absolute virtual path under ${VAULT_MOUNT_POINT}/ (e.g. ${VAULT_MOUNT_POINT}/notes/file.md).`,
					)
				}
				const strippedPath = path.startsWith(`${VAULT_MOUNT_POINT}/`)
					? path.slice(VAULT_MOUNT_POINT.length)
					: path
				const normalizedPath = normalizePath(strippedPath)

				if (!context.readTracker?.hasRead(normalizedPath)) {
					throw new Error(i18n.t('chatbox.errors.fileNotRead', { path }))
				}

				await permissionGuard?.({
					type: 'fs',
					fs: {
						kind: 'edit',
						path: `${VAULT_MOUNT_POINT}/${normalizedPath}`,
					},
				})

				const target = app.vault.getAbstractFileByPath(normalizedPath)

				if (!target) {
					throw new Error(i18n.t('chatbox.errors.fileNotFound', { path }))
				}
				if (!(target instanceof TFile)) {
					throw new Error(i18n.t('chatbox.errors.notFile', { path }))
				}

				const content = await app.vault.cachedRead(target)
				const replaced = replaceUniqueOccurrence(content, oldText, newText)
				await app.vault.modify(target, replaced.content)

				context.recordMetadata?.(toolCallId, {
					reversibleOps: [
						{
							vaultPath: normalizedPath,
							operation: 'update',
							before: {
								kind: 'file',
								contentCompressed: createCompressedFileContent(content),
							},
						},
					],
				})
				return { replaced: true as const }
			},
			toModelOutput: () => ({
				type: 'text',
				value: 'The file was updated successfully.',
			}),
		}),
		bash: tool({
			description:
				"Execute bash against a virtual filesystem where the Obsidian vault is mounted at /vault and built-in Skills are read-only under /.agents/skills. Use standard shell commands like ls, cat, rg, mkdir, mv, cp, and rm. Treat /vault as the user's personal knowledge base — only write there for content the user intends to keep; use /tmp for intermediate or scratch work.",
			inputSchema: z.object({
				script: textValue('script'),
				cwd: z._default(z.string(), VAULT_MOUNT_POINT),
				stdin: z.optional(z.string()),
				rawScript: z._default(booleanValue('rawScript'), false),
			}),
			outputSchema: z.string(),
			execute: async (
				params,
				{ context, toolCallId }: ToolExecutionOptions<AppToolContext>,
			) => {
				const cwd = params.cwd || VAULT_MOUNT_POINT
				if (!isAllowedBashCwd(cwd)) {
					throw new Error(
						`Invalid bash cwd: ${cwd}. Allowed roots are / and ${VAULT_MOUNT_POINT}`,
					)
				}

				const result = await execVaultBash(app, params.script, {
					cwd,
					stdin: params.stdin,
					rawScript: params.rawScript,
					permissionGuard,
					onRead: context.readTracker?.markRead.bind(context.readTracker),
					scratch: bashScratch,
				})
				const output = `${result.stdout}\n\n${result.stderr}`
				context.recordMetadata?.(toolCallId, {
					reversibleOps: result.reversibleOps,
				})
				if (output.length > MAX_INLINE_BASH_OUTPUT_CHARS) {
					const outputPath = `/tmp/${idAgent({ prefix: 'bash', words: 3 })}.txt`
					await writeBashTmpText(app, outputPath, output)
					return `Bash output was too long to return inline (${output.length} characters). The complete output was written to ${outputPath}. Use bash commands such as rg, sed, head, or tail to inspect it in smaller chunks.`
				}

				return output
			},
			toModelOutput: ({ output }) => ({
				type: 'text',
				value: output,
			}),
		}),
	}

	if (options.dispatchTask && options.allowSpawn !== false) {
		tools.task = createTaskTool({
			dispatchTask: options.dispatchTask,
			dispatchableDefinitions: options.dispatchableDefinitions,
		})
	}

	return tools
}
