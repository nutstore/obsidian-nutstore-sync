import { normalizePath, TFile } from 'obsidian'
import { posix as pathPosix } from 'path-browserify'
import { tool } from 'ai'
import { z } from 'zod/mini'
import i18n from '~/i18n'
import {
	listVaultPaths,
	ObsidianVaultFs,
	ReversibleOpRecorder,
} from '~/ai/tools/bash/fs'
import { VAULT_MOUNT_POINT } from '~/ai/tools/bash/runtime'
import { textValue } from './shared'
import {
	appDep,
	permissionGuardDep,
	readTrackerDep,
	recordMetadataDep,
} from './tool-context'

type PatchLineKind = 'context' | 'add' | 'delete'

interface PatchLine {
	kind: PatchLineKind
	text: string
}

interface PatchHunk {
	header: string
	lines: PatchLine[]
	endOfFile: boolean
}

type PatchOperation =
	| { kind: 'add'; path: string; content: string }
	| { kind: 'delete'; path: string }
	| {
			kind: 'update'
			path: string
			moveTo?: string
			hunks: PatchHunk[]
	  }

type PlannedOperation =
	| { kind: 'add'; path: string; content: string }
	| { kind: 'delete'; path: string; before: string }
	| {
			kind: 'update'
			path: string
			moveTo?: string
			before: string
			after: string
	  }

function invalidPatch(reason: string): never {
	throw new Error(`Invalid patch: ${reason}`)
}

function parseFileHeader(line: string, prefix: string) {
	const path = line.slice(prefix.length).trim()
	if (!path) {
		invalidPatch(`missing path after ${prefix.trim()}`)
	}
	return path
}

function parseHunkHeader(line: string) {
	const header = line.slice(2).trim()
	const unifiedHeader = header.match(
		/^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@(?:\s+(.*))?$/,
	)
	return unifiedHeader ? (unifiedHeader[1]?.trim() ?? '') : header
}

export function parsePatch(patch: string): PatchOperation[] {
	const lines = patch.replace(/\r\n/g, '\n').split('\n')
	if (lines[0] !== '*** Begin Patch') {
		invalidPatch('the first line must be "*** Begin Patch"')
	}

	let endIndex = lines.length - 1
	while (endIndex > 0 && lines[endIndex] === '') {
		endIndex -= 1
	}
	if (lines[endIndex] !== '*** End Patch') {
		invalidPatch('the last line must be "*** End Patch"')
	}

	const operations: PatchOperation[] = []
	let index = 1
	while (index < endIndex) {
		const line = lines[index]
		if (line.startsWith('*** Add File: ')) {
			const path = parseFileHeader(line, '*** Add File: ')
			index += 1
			const content: string[] = []
			while (index < endIndex && !lines[index].startsWith('*** ')) {
				if (!lines[index].startsWith('+')) {
					invalidPatch(
						`added file "${path}" contains a line without a + prefix`,
					)
				}
				content.push(lines[index].slice(1))
				index += 1
			}
			operations.push({
				kind: 'add',
				path,
				content: content.length > 0 ? `${content.join('\n')}\n` : '',
			})
			continue
		}

		if (line.startsWith('*** Delete File: ')) {
			operations.push({
				kind: 'delete',
				path: parseFileHeader(line, '*** Delete File: '),
			})
			index += 1
			continue
		}

		if (line.startsWith('*** Update File: ')) {
			const path = parseFileHeader(line, '*** Update File: ')
			index += 1
			let moveTo: string | undefined
			if (lines[index]?.startsWith('*** Move to: ')) {
				moveTo = parseFileHeader(lines[index], '*** Move to: ')
				index += 1
			}

			const hunks: PatchHunk[] = []
			while (index < endIndex && !lines[index].startsWith('*** ')) {
				if (!lines[index].startsWith('@@')) {
					invalidPatch(`expected a @@ hunk header while updating "${path}"`)
				}
				const header = parseHunkHeader(lines[index])
				index += 1
				const hunkLines: PatchLine[] = []
				let endOfFile = false
				while (
					index < endIndex &&
					!lines[index].startsWith('@@') &&
					!lines[index].startsWith('*** ')
				) {
					const prefix = lines[index][0]
					const kind =
						prefix === ' '
							? 'context'
							: prefix === '+'
								? 'add'
								: prefix === '-'
									? 'delete'
									: undefined
					if (!kind) {
						invalidPatch(
							`hunk for "${path}" contains a line without a space, +, or - prefix`,
						)
					}
					hunkLines.push({ kind, text: lines[index].slice(1) })
					index += 1
				}
				if (lines[index] === '*** End of File') {
					endOfFile = true
					index += 1
				}
				if (hunkLines.length === 0) {
					invalidPatch(`empty hunk while updating "${path}"`)
				}
				hunks.push({ header, lines: hunkLines, endOfFile })
			}
			if (hunks.length === 0 && !moveTo) {
				invalidPatch(`update for "${path}" has no hunks`)
			}
			operations.push({ kind: 'update', path, moveTo, hunks })
			continue
		}

		invalidPatch(`unexpected line "${line}"`)
	}

	if (operations.length === 0) {
		invalidPatch('no file operations were provided')
	}
	return operations
}

function normalizePatchPath(path: string) {
	if (path.startsWith('/') && !path.startsWith(`${VAULT_MOUNT_POINT}/`)) {
		throw new Error(
			`apply_patch can only access files inside the vault. Use a vault-relative path or an absolute virtual path under ${VAULT_MOUNT_POINT}/.`,
		)
	}
	const stripped = path.startsWith(`${VAULT_MOUNT_POINT}/`)
		? path.slice(VAULT_MOUNT_POINT.length + 1)
		: path
	const normalized = normalizePath(pathPosix.normalize(stripped))
	if (
		!normalized ||
		normalized === '.' ||
		normalized === '..' ||
		normalized.startsWith('../')
	) {
		invalidPatch(`path escapes the vault: "${path}"`)
	}
	return normalized
}

function findMatchingBlock(
	lines: string[],
	block: string[],
	start: number,
	path: string,
) {
	if (block.length === 0) {
		return start
	}
	const matches: number[] = []
	for (let index = start; index <= lines.length - block.length; index += 1) {
		if (block.every((line, offset) => lines[index + offset] === line)) {
			matches.push(index)
		}
	}
	if (matches.length === 0) {
		invalidPatch(`hunk context was not found in "${path}"`)
	}
	if (matches.length > 1) {
		invalidPatch(
			`hunk context matched ${matches.length} locations in "${path}"; include more context`,
		)
	}
	return matches[0]
}

export function applyHunks(content: string, hunks: PatchHunk[], path: string) {
	const newline = content.includes('\r\n') ? '\r\n' : '\n'
	const hasFinalNewline = content.endsWith('\n')
	const lines =
		content === ''
			? []
			: content
					.replace(/\r\n/g, '\n')
					.split('\n')
					.slice(0, hasFinalNewline ? -1 : undefined)
	let cursor = 0

	for (const hunk of hunks) {
		const oldLines = hunk.lines
			.filter((line) => line.kind !== 'add')
			.map((line) => line.text)
		const newLines = hunk.lines
			.filter((line) => line.kind !== 'delete')
			.map((line) => line.text)

		let searchStart = cursor
		if (hunk.header) {
			const headerMatches = lines
				.map((line, index) => ({ line, index }))
				.filter(
					(entry) =>
						entry.index >= cursor &&
						(entry.line === hunk.header || entry.line.includes(hunk.header)),
				)
			if (headerMatches.length === 0) {
				invalidPatch(`hunk header "${hunk.header}" was not found in "${path}"`)
			}
			if (headerMatches.length > 1) {
				invalidPatch(`hunk header "${hunk.header}" is not unique in "${path}"`)
			}
			searchStart = headerMatches[0].index
		}

		if (oldLines.length === 0 && !hunk.endOfFile && !hunk.header) {
			if (lines.length !== 0) {
				invalidPatch(
					`insertion in "${path}" needs context, a @@ header, or "*** End of File"`,
				)
			}
			searchStart = 0
		}
		const matchIndex = hunk.endOfFile
			? lines.length - oldLines.length
			: findMatchingBlock(lines, oldLines, searchStart, path)
		if (
			matchIndex < searchStart ||
			!oldLines.every((line, offset) => lines[matchIndex + offset] === line)
		) {
			invalidPatch(`end-of-file hunk context was not found in "${path}"`)
		}
		lines.splice(matchIndex, oldLines.length, ...newLines)
		cursor = matchIndex + newLines.length
	}

	const result = lines.join(newline)
	return hasFinalNewline && lines.length > 0 ? `${result}${newline}` : result
}

function assertUniquePaths(operations: PatchOperation[]) {
	const claimed = new Set<string>()
	for (const operation of operations) {
		const paths = [
			operation.path,
			...(operation.kind === 'update' && operation.moveTo
				? [operation.moveTo]
				: []),
		]
		for (const path of paths) {
			if (claimed.has(path)) {
				invalidPatch(`multiple operations target "${path}"`)
			}
			claimed.add(path)
		}
	}
}

export const applyPatchTool = tool({
	description: [
		'Apply a file-oriented patch inside the Obsidian vault.',
		'Use bash rather than this tool for files under /.agents.',
		'Every patch, including one that only adds, deletes, updates, or moves a single file, MUST start with "*** Begin Patch" and end with "*** End Patch".',
		'A Delete patch has this complete form: "*** Begin Patch\\n*** Delete File: notes/example.md\\n*** End Patch".',
		'An Update patch has this complete form: "*** Begin Patch\\n*** Update File: notes/example.md\\n@@\\n-old text\\n+new text\\n*** End Patch".',
		'File operation headers always use the colon syntax: "*** Add File: path", "*** Delete File: path", "*** Update File: path", and "*** Move to: path".',
		'Update sections contain @@ hunks; unified numeric headers such as @@ -10,3 +10,4 @@ are also accepted.',
		'Unchanged lines start with a space, removals with -, and additions with +.',
		'Include *** Move to immediately after an Update File header only when renaming the file; its value must be the destination vault path, never a description of the edit.',
		'Include enough unchanged context for every hunk to match exactly once.',
		'Read existing files before updating, deleting, or moving them.',
	].join(' '),
	inputSchema: z.object({
		patch: textValue('patch'),
	}),
	contextSchema: z.object({
		app: appDep,
		permissionGuard: permissionGuardDep,
		readTracker: readTrackerDep,
		recordMetadata: recordMetadataDep,
	}),
	outputSchema: z.object({
		applied: z.literal(true),
		files: z.array(z.string()),
	}),
	execute: async ({ patch }, { context, toolCallId }) => {
		const { app, permissionGuard, readTracker, recordMetadata } = context
		const operations = parsePatch(patch).map((operation) => ({
			...operation,
			path: normalizePatchPath(operation.path),
			...(operation.kind === 'update' && operation.moveTo
				? { moveTo: normalizePatchPath(operation.moveTo) }
				: {}),
		}))
		assertUniquePaths(operations)

		const planned: PlannedOperation[] = []
		for (const operation of operations) {
			const target = app.vault.getAbstractFileByPath(operation.path)
			if (operation.kind === 'add') {
				if (target) {
					invalidPatch(
						`cannot add "${operation.path}" because it already exists`,
					)
				}
				planned.push(operation)
				continue
			}
			if (!readTracker?.hasRead(operation.path)) {
				throw new Error(
					i18n.t('chatbox.errors.fileNotRead', { path: operation.path }),
				)
			}
			if (!target) {
				throw new Error(
					i18n.t('chatbox.errors.fileNotFound', { path: operation.path }),
				)
			}
			if (!(target instanceof TFile)) {
				throw new Error(
					i18n.t('chatbox.errors.notFile', { path: operation.path }),
				)
			}
			const before = await app.vault.cachedRead(target)
			if (operation.kind === 'delete') {
				planned.push({ ...operation, before })
				continue
			}
			if (
				operation.moveTo &&
				operation.moveTo !== operation.path &&
				app.vault.getAbstractFileByPath(operation.moveTo)
			) {
				invalidPatch(
					`cannot move "${operation.path}" to "${operation.moveTo}" because the destination exists`,
				)
			}
			planned.push({
				...operation,
				before,
				after: applyHunks(before, operation.hunks, operation.path),
			})
		}

		for (const operation of planned) {
			if (operation.kind === 'add') {
				await permissionGuard?.({
					type: 'fs',
					fs: {
						kind: 'write',
						path: `${VAULT_MOUNT_POINT}/${operation.path}`,
					},
				})
				continue
			}
			if (operation.kind === 'delete') {
				await permissionGuard?.({
					type: 'fs',
					fs: {
						kind: 'delete',
						path: `${VAULT_MOUNT_POINT}/${operation.path}`,
					},
				})
				continue
			}
			await permissionGuard?.({
				type: 'fs',
				fs: {
					kind: 'edit',
					path: `${VAULT_MOUNT_POINT}/${operation.path}`,
				},
			})
			if (operation.moveTo && operation.moveTo !== operation.path) {
				await permissionGuard?.({
					type: 'fs',
					fs: {
						kind: 'move',
						src: `${VAULT_MOUNT_POINT}/${operation.path}`,
						dest: `${VAULT_MOUNT_POINT}/${operation.moveTo}`,
					},
				})
			}
		}

		const recorder = new ReversibleOpRecorder()
		const fs = new ObsidianVaultFs(
			app.vault,
			await listVaultPaths(app),
			undefined,
			recorder,
		)
		for (const operation of planned) {
			const path = `/${operation.path}`
			if (operation.kind === 'add') {
				await fs.writeFile(path, operation.content)
			} else if (operation.kind === 'delete') {
				await fs.rm(path)
			} else {
				if (operation.after !== operation.before) {
					await fs.writeFile(path, operation.after)
				}
				if (operation.moveTo && operation.moveTo !== operation.path) {
					await fs.mv(path, `/${operation.moveTo}`)
				}
			}
		}

		const reversibleOps = await recorder.getNetOperations(app.vault)
		recordMetadata?.(toolCallId, { reversibleOps })
		const files = [
			...new Set(
				planned.flatMap((operation) =>
					operation.kind === 'update' && operation.moveTo
						? [operation.path, operation.moveTo]
						: [operation.path],
				),
			),
		]
		return { applied: true as const, files }
	},
	toModelOutput: ({ output }) => ({
		type: 'text',
		value: `Done!\n${output.files.map((path) => `- ${path}`).join('\n')}`,
	}),
})
