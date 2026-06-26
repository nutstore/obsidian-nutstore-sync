import { normalizePath } from 'obsidian'
import { hasCompressedFileContent } from '~/ai/chat/messages/reversible-content'
import { cloneReversibleToolOp } from '~/ai/chat/domain'
import type { AIMessageRecord } from '~/ai/core/types'

export function getPathDepth(path: string) {
	return path.split('/').filter(Boolean).length
}

export function getParentVaultPaths(path: string) {
	const parts = path.split('/').filter(Boolean)
	const parents: string[] = []
	let current = ''
	for (let index = 0; index < parts.length - 1; index += 1) {
		current = current ? `${current}/${parts[index]}` : parts[index]
		parents.push(current)
	}
	return parents
}

export function normalizeReversibleVaultPath(path: string) {
	const trimmed = path.trim()
	if (!trimmed) {
		return ''
	}
	const normalized = normalizePath(trimmed.replace(/^\/+/, ''))
	return normalized === '.' ? '' : normalized
}

export function normalizeReversibleToolOpRecord(
	op: NonNullable<AIMessageRecord['reversibleOps']>[number],
) {
	const normalizedPath = normalizeReversibleVaultPath(op.vaultPath)
	if (!normalizedPath) {
		return null
	}
	if (op.operation === 'update') {
		if (
			!hasCompressedFileContent(op.before) &&
			typeof op.before.contentBase64 !== 'string'
		) {
			return null
		}
	}
	if (op.operation === 'delete' && op.before.kind === 'file') {
		const before = op.before
		if (
			!hasCompressedFileContent(before) &&
			typeof before.contentBase64 !== 'string'
		) {
			return null
		}
	}
	const cloned = cloneReversibleToolOp(op)
	return {
		...cloned,
		vaultPath: normalizedPath,
	}
}

export function isVaultFolder(
	target: unknown,
): target is { path: string; children: unknown[] } {
	return !!target && typeof target === 'object' && 'children' in target
}

export function isVaultFile(target: unknown): target is { path: string } {
	return !!target && typeof target === 'object' && !('children' in target)
}
