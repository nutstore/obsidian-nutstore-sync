import type { ReversibleToolOp } from '~/ai/chat/types'
import { LEGACY_VAULT_MOUNT_POINT } from '~/ai/tools/bash/mount-points'
import { hasCompressedFileContent } from '~/ai/chat/messages/reversible-content'
import { normalizeVaultPath } from '~/utils/normalize-vault-path'

function copyFileSnapshot(
	snapshot: Extract<ReversibleToolOp, { operation: 'update' }>['before'],
) {
	return {
		kind: 'file' as const,
		contentCompressed: snapshot.contentCompressed
			? { ...snapshot.contentCompressed }
			: undefined,
		contentBase64: snapshot.contentBase64,
	}
}

export function copyReversibleToolOp(op: ReversibleToolOp): ReversibleToolOp {
	switch (op.operation) {
		case 'create':
			return {
				vaultPath: op.vaultPath,
				operation: 'create',
				before: { kind: op.before.kind },
				after:
					op.after?.kind === 'file'
						? copyFileSnapshot(op.after)
						: op.after
							? { kind: 'dir' as const }
							: undefined,
				toolCallId: op.toolCallId,
			}
		case 'update':
			return {
				vaultPath: op.vaultPath,
				operation: 'update',
				before: copyFileSnapshot(op.before),
				after: op.after ? copyFileSnapshot(op.after) : undefined,
				toolCallId: op.toolCallId,
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
				toolCallId: op.toolCallId,
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
	if (
		trimmed === LEGACY_VAULT_MOUNT_POINT ||
		trimmed.startsWith(`${LEGACY_VAULT_MOUNT_POINT}/`)
	) {
		const normalized = normalizeVaultPath(
			trimmed.slice(LEGACY_VAULT_MOUNT_POINT.length + 1),
		)
		return normalized === '.' ? '' : normalized
	}
	if (trimmed.startsWith('/')) {
		return `/${normalizeVaultPath(trimmed).replace(/^\/+/, '')}`
	}
	const normalized = normalizeVaultPath(trimmed.replace(/^\/+/, ''))
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
		if (
			op.after &&
			!hasCompressedFileContent(op.after) &&
			typeof op.after.contentBase64 !== 'string'
		) {
			return null
		}
	}
	if (op.operation === 'create' && op.after?.kind === 'file') {
		if (
			!hasCompressedFileContent(op.after) &&
			typeof op.after.contentBase64 !== 'string'
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
