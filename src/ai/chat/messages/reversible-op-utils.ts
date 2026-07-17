import type { ReversibleToolOp } from '~/ai/chat/types'
import { normalizePath } from 'obsidian'
import { hasCompressedFileContent } from '~/ai/chat/messages/reversible-content'

export function copyReversibleToolOp(op: ReversibleToolOp): ReversibleToolOp {
	switch (op.operation) {
		case 'create':
			return {
				vaultPath: op.vaultPath,
				operation: 'create',
				before: { kind: op.before.kind },
			}
		case 'update':
			return {
				vaultPath: op.vaultPath,
				operation: 'update',
				before: {
					kind: 'file',
					contentCompressed: op.before.contentCompressed
						? { ...op.before.contentCompressed }
						: undefined,
					contentBase64: op.before.contentBase64,
				},
			}
		case 'delete':
			return {
				vaultPath: op.vaultPath,
				operation: 'delete',
				before:
					op.before.kind === 'dir'
						? { kind: 'dir' }
						: {
								kind: 'file',
								contentCompressed: op.before.contentCompressed
									? { ...op.before.contentCompressed }
									: undefined,
								contentBase64: op.before.contentBase64,
							},
			}
	}
}

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

export function normalizeReversibleToolOpRecord(op: ReversibleToolOp) {
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
	const copied = copyReversibleToolOp(op)
	return {
		...copied,
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
