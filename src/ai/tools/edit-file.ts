import { normalizePath, TFile } from 'obsidian'
import { tool } from 'ai'
import { z } from 'zod/mini'
import i18n from '~/i18n'
import { VAULT_MOUNT_POINT } from '~/ai/tools/bash/runtime'
import { createCompressedFileContent } from '~/ai/chat/messages/reversible-content'
import { replaceUniqueOccurrence, textValue } from './shared'
import {
	appDep,
	permissionGuardDep,
	readTrackerDep,
	recordMetadataDep,
} from './tool-context'

export const editFileTool = tool({
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
	contextSchema: z.object({
		app: appDep,
		permissionGuard: permissionGuardDep,
		readTracker: readTrackerDep,
		recordMetadata: recordMetadataDep,
	}),
	outputSchema: z.object({
		replaced: z.literal(true),
	}),
	execute: async (params, { context, toolCallId }) => {
		const { app, permissionGuard, readTracker, recordMetadata } = context
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

		if (!readTracker?.hasRead(normalizedPath)) {
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

		recordMetadata?.(toolCallId, {
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
})
