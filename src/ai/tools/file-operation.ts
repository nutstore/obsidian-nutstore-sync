export const AI_FILE_OPERATIONS = [
	'copy',
	'delete',
	'edit',
	'mkdir',
	'move',
	'read',
	'write',
] as const

export type AIFileOperation = (typeof AI_FILE_OPERATIONS)[number]
export type AISinglePathFileOperation = Exclude<
	AIFileOperation,
	'copy' | 'move'
>
export type AIDualPathFileOperation = Extract<AIFileOperation, 'copy' | 'move'>

export interface ReadTracker {
	markRead(vaultPath: string): void
	hasRead(vaultPath: string): boolean
	resetSnapshot(): void
}

export function createFragmentReadTracker(
	source: { readVaultPaths?: string[] },
	readSnapshot?: ReadonlySet<string>,
): ReadTracker {
	let snapshot = readSnapshot ?? new Set(source.readVaultPaths ?? [])
	return {
		markRead(vaultPath: string) {
			if (!vaultPath) {
				return
			}
			const paths = (source.readVaultPaths ??= [])
			if (!paths.includes(vaultPath)) {
				paths.push(vaultPath)
			}
		},
		hasRead(vaultPath: string) {
			return snapshot.has(vaultPath)
		},
		resetSnapshot() {
			snapshot = new Set(source.readVaultPaths ?? [])
		},
	}
}
