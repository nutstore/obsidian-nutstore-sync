import { diff_match_patch } from 'diff-match-patch'
import { decodeReversibleFileSnapshot } from './reversible-content'
import type { ReversibleFileSnapshot, ReversibleToolOp } from '../types'

const CONTEXT_LINES = 2

export interface FileDiffLine {
	kind: 'context' | 'add' | 'remove'
	oldLine?: number
	newLine?: number
	text: string
	segments?: FileDiffSegment[]
}

export interface FileDiffSegment {
	text: string
	changed: boolean
}

export interface FileDiffHunk {
	oldStart: number
	oldCount: number
	newStart: number
	newCount: number
	lines: FileDiffLine[]
}

export interface FileDiff {
	vaultPath: string
	operation: ReversibleToolOp['operation']
	hunks?: FileDiffHunk[]
	binary?: boolean
}

interface ProjectedLine {
	line: number
	text: string
	segments: FileDiffSegment[]
	changed: boolean
}

function createProjectedLine(line: number): ProjectedLine {
	return { line, text: '', segments: [], changed: false }
}

function appendSegment(line: ProjectedLine, text: string, changed: boolean) {
	if (!text) return
	line.text += text
	line.changed ||= changed
	const previous = line.segments.at(-1)
	if (previous?.changed === changed) {
		previous.text += text
	} else {
		line.segments.push({ text, changed })
	}
}

function projectDiffLines(beforeText: string, afterText: string) {
	const dmp = new diff_match_patch()
	const diffs = dmp.diff_main(beforeText, afterText)
	dmp.diff_cleanupSemantic(diffs)

	const lines: FileDiffLine[] = []
	const pendingOld: ProjectedLine[] = []
	const pendingNew: ProjectedLine[] = []
	let oldLineNumber = 1
	let newLineNumber = 1
	let oldLine = createProjectedLine(oldLineNumber)
	let newLine = createProjectedLine(newLineNumber)

	const finishOldLine = (newlineChanged = false) => {
		oldLine.changed ||= newlineChanged
		const finished = oldLine
		oldLineNumber += 1
		oldLine = createProjectedLine(oldLineNumber)
		return finished
	}
	const finishNewLine = (newlineChanged = false) => {
		newLine.changed ||= newlineChanged
		const finished = newLine
		newLineNumber += 1
		newLine = createProjectedLine(newLineNumber)
		return finished
	}
	const flushChanges = () => {
		for (const line of pendingOld) {
			lines.push({
				kind: 'remove',
				oldLine: line.line,
				text: line.text,
				segments: line.segments,
			})
		}
		for (const line of pendingNew) {
			lines.push({
				kind: 'add',
				newLine: line.line,
				text: line.text,
				segments: line.segments,
			})
		}
		pendingOld.length = 0
		pendingNew.length = 0
	}
	const finishSharedLine = () => {
		const oldFinished = finishOldLine()
		const newFinished = finishNewLine()
		if (
			!oldFinished.changed &&
			!newFinished.changed &&
			oldFinished.text === newFinished.text
		) {
			flushChanges()
			lines.push({
				kind: 'context',
				oldLine: oldFinished.line,
				newLine: newFinished.line,
				text: oldFinished.text,
			})
			return
		}
		pendingOld.push(oldFinished)
		pendingNew.push(newFinished)
	}

	for (const [operation, text] of diffs) {
		const parts = text.split('\n')
		for (let index = 0; index < parts.length; index += 1) {
			const part = parts[index]
			if (operation !== diff_match_patch.DIFF_INSERT) {
				appendSegment(oldLine, part, operation === diff_match_patch.DIFF_DELETE)
			}
			if (operation !== diff_match_patch.DIFF_DELETE) {
				appendSegment(newLine, part, operation === diff_match_patch.DIFF_INSERT)
			}
			if (index === parts.length - 1) continue

			if (operation === diff_match_patch.DIFF_EQUAL) {
				finishSharedLine()
			} else if (operation === diff_match_patch.DIFF_DELETE) {
				pendingOld.push(finishOldLine(true))
			} else {
				pendingNew.push(finishNewLine(true))
			}
		}
	}

	const oldTail =
		beforeText && !beforeText.endsWith('\n') ? finishOldLine() : undefined
	const newTail =
		afterText && !afterText.endsWith('\n') ? finishNewLine() : undefined
	if (
		oldTail &&
		newTail &&
		!oldTail.changed &&
		!newTail.changed &&
		oldTail.text === newTail.text
	) {
		flushChanges()
		lines.push({
			kind: 'context',
			oldLine: oldTail.line,
			newLine: newTail.line,
			text: oldTail.text,
		})
	} else {
		if (oldTail) pendingOld.push(oldTail)
		if (newTail) pendingNew.push(newTail)
		flushChanges()
	}

	return lines
}

function buildHunks(lines: FileDiffLine[]): FileDiffHunk[] {
	const changedLines = lines
		.map((line, index) => (line.kind === 'context' ? undefined : index))
		.filter((index): index is number => index !== undefined)
	if (!changedLines.length) return []
	const oldPrefix = [0]
	const newPrefix = [0]
	for (const line of lines) {
		oldPrefix.push(
			oldPrefix[oldPrefix.length - 1] + (line.kind === 'add' ? 0 : 1),
		)
		newPrefix.push(
			newPrefix[newPrefix.length - 1] + (line.kind === 'remove' ? 0 : 1),
		)
	}

	const groups: number[][] = []
	for (const index of changedLines) {
		const previous = groups.at(-1)
		if (
			previous &&
			index - previous[previous.length - 1] - 1 <= CONTEXT_LINES * 2
		) {
			previous.push(index)
		} else {
			groups.push([index])
		}
	}

	return groups.map((group) => {
		const start = Math.max(0, group[0] - CONTEXT_LINES)
		const end = Math.min(
			lines.length,
			group[group.length - 1] + CONTEXT_LINES + 1,
		)
		const hunkLines = lines.slice(start, end)
		return {
			oldStart: oldPrefix[start] + 1,
			oldCount: oldPrefix[end] - oldPrefix[start],
			newStart: newPrefix[start] + 1,
			newCount: newPrefix[end] - newPrefix[start],
			lines: hunkLines,
		}
	})
}

export function buildLineDiff(
	beforeText: string,
	afterText: string,
): FileDiffHunk[] {
	if (beforeText === afterText) return []
	return buildHunks(projectDiffLines(beforeText, afterText))
}

async function snapshotText(snapshot: ReversibleFileSnapshot) {
	const bytes = new Uint8Array(await decodeReversibleFileSnapshot(snapshot))
	if (bytes.includes(0)) return undefined
	const text = new TextDecoder().decode(bytes)
	const replacements = text.match(/\uFFFD/g)?.length ?? 0
	return replacements > Math.max(1, text.length / 100) ? undefined : text
}

export async function buildFileDiff(
	change: ReversibleToolOp,
): Promise<FileDiff | undefined> {
	if (change.operation === 'create') {
		if (!change.after) return undefined
		if (change.after.kind === 'dir') {
			return { vaultPath: change.vaultPath, operation: change.operation }
		}
		const after = await snapshotText(change.after)
		return after === undefined
			? {
					vaultPath: change.vaultPath,
					operation: change.operation,
					binary: true,
				}
			: {
					vaultPath: change.vaultPath,
					operation: change.operation,
					hunks: buildLineDiff('', after),
				}
	}
	if (change.operation === 'delete') {
		if (change.before.kind === 'dir') {
			return { vaultPath: change.vaultPath, operation: change.operation }
		}
		const before = await snapshotText(change.before)
		return before === undefined
			? {
					vaultPath: change.vaultPath,
					operation: change.operation,
					binary: true,
				}
			: {
					vaultPath: change.vaultPath,
					operation: change.operation,
					hunks: buildLineDiff(before, ''),
				}
	}
	if (!change.after) return undefined
	const [before, after] = await Promise.all([
		snapshotText(change.before),
		snapshotText(change.after),
	])
	return before === undefined || after === undefined
		? { vaultPath: change.vaultPath, operation: change.operation, binary: true }
		: {
				vaultPath: change.vaultPath,
				operation: change.operation,
				hunks: buildLineDiff(before, after),
			}
}
