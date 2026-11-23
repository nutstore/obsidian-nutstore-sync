import { posix as pathPosix } from 'path-browserify'
import { tool } from 'ai'
import * as z from 'zod/mini'
import i18n from '~/i18n'
import { isNotFoundError, ReversibleOpRecorder } from '~/ai/tools/bash/fs'
import {
	AGENTS_MOUNT_POINT,
	SETTINGS_FILE_PATH,
} from '~/ai/tools/bash/mount-points'
import {
	assertCanonicalVirtualPathCharacters,
	normalizeVirtualPath,
} from '~/ai/tools/bash/virtual-path'
import { createVaultFileSystem } from '~/ai/tools/vault-filesystem'
import { withPermissionPurpose } from './permission-guard'
import { textValue } from './shared'
import {
	appDep,
	fileSystemManagerDep,
	getSettingsSnapshotDep,
	permissionGuardDep,
	readTrackerDep,
	recordMetadataDep,
	updateSettingsDep,
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

const utf8Decoder = new TextDecoder('utf-8')

export function parsePatch(patch: string): PatchOperation[] {
	const normalizedPatch = patch.includes('\r\n')
		? patch.replace(/\r\n/g, '\n')
		: patch
	const lines = normalizedPatch.split('\n')
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

function resolveVirtualPath(rawPath: string): string {
	const trimmed = rawPath.trim()
	if (!trimmed) {
		invalidPatch(`empty path`)
	}
	assertCanonicalVirtualPathCharacters(trimmed)
	const normalized = pathPosix.normalize(trimmed)
	if (
		!pathPosix.isAbsolute(normalized) &&
		(normalized === '.' || normalized === '..' || normalized.startsWith('../'))
	) {
		invalidPatch(`path escapes the vault: "${rawPath}"`)
	}
	return normalizeVirtualPath(trimmed)
}

/**
 * Key under which a virtual path is tracked as "read". Vault and adapter
 * mounts (bash reports them via their vault-relative onRead), while the
 * settings file is tracked by its full virtual path.
 */
function toReadKey(virtualPath: string): string {
	const normalized = normalizeVirtualPath(virtualPath)
	if (
		normalized === SETTINGS_FILE_PATH ||
		normalized.startsWith(`${SETTINGS_FILE_PATH}/`)
	) {
		return normalized
	}
	return normalized.startsWith('/') ? normalized.slice(1) : normalized
}

/** User-facing path: vault-relative for vault (back-compat), virtual otherwise. */
function toDisplayKey(virtualPath: string): string {
	const normalized = normalizeVirtualPath(virtualPath)
	if (
		normalized === AGENTS_MOUNT_POINT ||
		normalized.startsWith(`${AGENTS_MOUNT_POINT}/`) ||
		normalized === SETTINGS_FILE_PATH ||
		normalized.startsWith(`${SETTINGS_FILE_PATH}/`)
	) {
		return normalized
	}
	return normalized.startsWith('/') ? normalized.slice(1) : normalized
}

function buildLineFailureTable(block: readonly string[]): Int32Array {
	const lps = new Int32Array(block.length)
	let prefixLength = 0
	for (let index = 1; index < block.length; index += 1) {
		while (prefixLength > 0 && block[index] !== block[prefixLength]) {
			prefixLength = lps[prefixLength - 1]
		}
		if (block[index] === block[prefixLength]) {
			prefixLength += 1
			lps[index] = prefixLength
		}
	}
	return lps
}

function blockMatchesAt(
	lines: readonly string[],
	block: readonly string[],
	start: number,
) {
	if (start < 0 || start + block.length > lines.length) return false
	for (let offset = 0; offset < block.length; offset += 1) {
		if (lines[start + offset] !== block[offset]) return false
	}
	return true
}

function findUniqueHunkHeader(
	lines: readonly string[],
	header: string,
	start: number,
	path: string,
) {
	let firstMatch = -1
	for (let index = start; index < lines.length; index += 1) {
		if (!lines[index].includes(header)) continue
		if (firstMatch !== -1) {
			invalidPatch(`hunk header "${header}" is not unique in "${path}"`)
		}
		firstMatch = index
	}
	if (firstMatch === -1) {
		invalidPatch(`hunk header "${header}" was not found in "${path}"`)
	}
	return firstMatch
}

/**
 * Finds the unique occurrence of `block` in `lines` at or after `start` in
 * linear O(n + m) time using KMP, preserving exact overlapping match counts.
 */
function findMatchingBlock(
	lines: readonly string[],
	block: readonly string[],
	start: number,
	path: string,
) {
	const blockLength = block.length
	if (blockLength === 0) {
		return start
	}
	let matchCount = 0
	let firstMatch = -1
	if (blockLength === 1) {
		const target = block[0]
		for (let index = start; index < lines.length; index += 1) {
			if (lines[index] === target) {
				if (matchCount === 0) firstMatch = index
				matchCount += 1
			}
		}
	} else if (start + blockLength <= lines.length) {
		const lps = buildLineFailureTable(block)
		let matched = 0
		for (let index = start; index < lines.length; index += 1) {
			const line = lines[index]
			while (matched > 0 && line !== block[matched]) {
				matched = lps[matched - 1]
			}
			if (line === block[matched]) {
				matched += 1
				if (matched === blockLength) {
					if (matchCount === 0) firstMatch = index - blockLength + 1
					matchCount += 1
					matched = lps[matched - 1]
				}
			}
		}
	}
	if (matchCount === 0) {
		invalidPatch(`hunk context was not found in "${path}"`)
	}
	if (matchCount > 1) {
		invalidPatch(
			`hunk context matched ${matchCount} locations in "${path}"; include more context`,
		)
	}
	return firstMatch
}

export function applyHunks(content: string, hunks: PatchHunk[], path: string) {
	const hasCrLf = content.includes('\r\n')
	const newline = hasCrLf ? '\r\n' : '\n'
	const hasFinalNewline = content.endsWith('\n')
	const normalizedContent = hasCrLf ? content.replace(/\r\n/g, '\n') : content
	const lines =
		normalizedContent === ''
			? []
			: hasFinalNewline
				? normalizedContent.slice(0, -1).split('\n')
				: normalizedContent.split('\n')
	// Hunks advance strictly forward over original lines; assembling into a fresh
	// output array stays O(n + inserted) instead of O(hunks * n) splicing and
	// avoids call-stack overflow on large `splice(..., ...newLines)` spreads.
	const resultLines: string[] = []
	let sourceCursor = 0

	for (const hunk of hunks) {
		const oldLines: string[] = []
		const newLines: string[] = []
		for (const line of hunk.lines) {
			if (line.kind !== 'add') oldLines.push(line.text)
			if (line.kind !== 'delete') newLines.push(line.text)
		}

		let searchStart = sourceCursor
		if (hunk.header) {
			searchStart = findUniqueHunkHeader(lines, hunk.header, sourceCursor, path)
		}

		if (oldLines.length === 0 && !hunk.endOfFile && !hunk.header) {
			const remainingLength = resultLines.length + (lines.length - sourceCursor)
			if (remainingLength !== 0) {
				invalidPatch(
					`insertion in "${path}" needs context, a @@ header, or "*** End of File"`,
				)
			}
			searchStart = sourceCursor
		}
		const matchIndex = hunk.endOfFile
			? lines.length - oldLines.length
			: findMatchingBlock(lines, oldLines, searchStart, path)
		if (
			matchIndex < searchStart ||
			!blockMatchesAt(lines, oldLines, matchIndex)
		) {
			invalidPatch(`end-of-file hunk context was not found in "${path}"`)
		}
		for (let index = sourceCursor; index < matchIndex; index += 1) {
			resultLines.push(lines[index])
		}
		for (let index = 0; index < newLines.length; index += 1) {
			resultLines.push(newLines[index])
		}
		sourceCursor = matchIndex + oldLines.length
	}

	for (let index = sourceCursor; index < lines.length; index += 1) {
		resultLines.push(lines[index])
	}

	const result = resultLines.join(newline)
	return hasFinalNewline && resultLines.length > 0
		? `${result}${newline}`
		: result
}

function assertUniqueVirtualPaths(paths: string[]) {
	const claimed = new Set<string>()
	for (const virtual of paths) {
		if (claimed.has(virtual)) {
			invalidPatch(`multiple operations target "${virtual}"`)
		}
		claimed.add(virtual)
	}
}

export const applyPatchTool = tool({
	description: [
		'Apply a file-oriented patch to writable virtual filesystem paths (vault-relative or absolute virtual paths).',
		"purpose (<=120 chars): plain-language summary in the user's language of what this patch changes and why — no code, markdown, newlines, or patch syntax.",
		'Wrap every patch in "*** Begin Patch" and "*** End Patch".',
		'Operations: "*** Add File: path" (every content line, including blank lines, starts with "+"); "*** Delete File: path"; "*** Update File: path" with optional immediately following "*** Move to: destPath" (destination path only) and "@@" hunks (unified "@@ -a,b +c,d @@" accepted; unchanged lines start with " ", removals "-", additions "+"; optional "*** End of File").',
		'Add example: "*** Begin Patch\\n*** Add File: notes/example.md\\n+Example\\n+\\n+示例行 🌱\\n*** End Patch".',
		'Include enough unchanged context for every hunk to match uniquely. Read existing files before updating, deleting, or moving them.',
	].join(' '),
	inputSchema: z.object({
		purpose: textValue('purpose').check(
			z.maxLength(
				120,
				i18n.t('chatbox.errors.toolFieldTooLong', { field: 'purpose' }),
			),
		),
		patch: textValue('patch'),
	}),
	contextSchema: z.object({
		app: appDep,
		fileSystemManager: fileSystemManagerDep,
		permissionGuard: permissionGuardDep,
		readTracker: readTrackerDep,
		recordMetadata: recordMetadataDep,
		getSettingsSnapshot: getSettingsSnapshotDep,
		updateSettings: updateSettingsDep,
	}),
	outputSchema: z.object({
		applied: z.literal(true),
		files: z.array(z.string()),
	}),
	execute: async ({ patch, purpose }, { context, toolCallId }) => {
		const {
			app,
			fileSystemManager,
			permissionGuard,
			readTracker,
			recordMetadata,
			getSettingsSnapshot,
			updateSettings,
		} = context
		const operations = parsePatch(patch)

		const virtualPaths = new Map<string, string>()
		for (const operation of operations) {
			virtualPaths.set(operation.path, resolveVirtualPath(operation.path))
			if (operation.kind === 'update' && operation.moveTo) {
				virtualPaths.set(operation.moveTo, resolveVirtualPath(operation.moveTo))
			}
		}
		assertUniqueVirtualPaths([...virtualPaths.values()])

		const recorder = new ReversibleOpRecorder()
		const mountable = await createVaultFileSystem(app, {
			permissionGuard: withPermissionPurpose(permissionGuard, purpose),
			recorder,
			onRead: (vaultPath) => readTracker?.markRead(vaultPath),
			getSettingsSnapshot,
			updateSettings,
			fileSystemManager,
			includePathIndex: false,
		})

		const planned: PlannedOperation[] = []
		for (const operation of operations) {
			const path = virtualPaths.get(operation.path)!
			if (operation.kind === 'add') {
				if (await mountable.exists(path)) {
					invalidPatch(
						`cannot add "${operation.path}" because it already exists`,
					)
				}
				planned.push({ kind: 'add', path, content: operation.content })
				continue
			}
			if (
				!readTracker?.hasRead(path) &&
				!readTracker?.hasRead(toReadKey(path))
			) {
				throw new Error(
					i18n.t('chatbox.errors.fileNotRead', { path: operation.path }),
				)
			}
			let rawBefore: Uint8Array
			try {
				rawBefore = await mountable.readFileBuffer(path)
			} catch (error) {
				if (isNotFoundError(error)) {
					throw new Error(
						i18n.t('chatbox.errors.fileNotFound', { path: operation.path }),
						{ cause: error },
					)
				}
				throw error
			}
			const before = utf8Decoder.decode(rawBefore)
			if (operation.kind === 'delete') {
				planned.push({ kind: 'delete', path, before })
				continue
			}
			const moveTo = operation.moveTo
				? virtualPaths.get(operation.moveTo)
				: undefined
			if (moveTo && moveTo !== path && (await mountable.exists(moveTo))) {
				invalidPatch(
					`cannot move "${operation.path}" to "${operation.moveTo}" because the destination exists`,
				)
			}
			planned.push({
				kind: 'update',
				path,
				moveTo,
				before,
				after: applyHunks(before, operation.hunks, operation.path),
			})
		}

		for (const operation of planned) {
			if (operation.kind === 'add') {
				await mountable.writeFile(operation.path, operation.content)
			} else if (operation.kind === 'delete') {
				await mountable.rm(operation.path)
			} else {
				if (operation.after !== operation.before) {
					await mountable.writeFile(operation.path, operation.after)
				}
				if (operation.moveTo && operation.moveTo !== operation.path) {
					await mountable.mv(operation.path, operation.moveTo)
				}
			}
		}

		const reversibleOps = await recorder.getNetOperations()
		recordMetadata?.(toolCallId, { reversibleOps })
		const files = [
			...new Set(
				planned.flatMap((operation) =>
					operation.kind === 'update' && operation.moveTo
						? [toDisplayKey(operation.path), toDisplayKey(operation.moveTo)]
						: [toDisplayKey(operation.path)],
				),
			),
		]
		return { applied: true as const, files }
	},
	toModelOutput: ({ output }) => ({
		type: 'text',
		value: ['Done!', ...output.files.map((path) => `- ${path}`)].join('\n'),
	}),
})
