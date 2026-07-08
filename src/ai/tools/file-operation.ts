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
}

export function createFragmentReadTracker(
	fragment: { readVaultPaths?: string[] },
	readSnapshot?: ReadonlySet<string>,
): ReadTracker {
	const snapshot = readSnapshot ?? new Set(fragment.readVaultPaths ?? [])
	return {
		markRead(vaultPath: string) {
			if (!vaultPath) {
				return
			}
			const paths = (fragment.readVaultPaths ??= [])
			if (!paths.includes(vaultPath)) {
				paths.push(vaultPath)
			}
		},
		hasRead(vaultPath: string) {
			return snapshot.has(vaultPath)
		},
	}
}
