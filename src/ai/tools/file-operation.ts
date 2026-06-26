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
