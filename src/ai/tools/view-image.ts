import { tool } from 'ai'
import { posix as pathPosix } from 'path-browserify'
import { z } from 'zod/mini'
import i18n from '~/i18n'
import { createVaultFileSystem, VAULT_MOUNT_POINT } from './vault-filesystem'
import {
	appDep,
	fileSystemManagerDep,
	readTrackerDep,
	viewImageAttachmentsDep,
} from './tool-context'

const IMAGE_MEDIA_TYPES: Record<string, string> = {
	avif: 'image/avif',
	bmp: 'image/bmp',
	gif: 'image/gif',
	ico: 'image/x-icon',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	svg: 'image/svg+xml',
	webp: 'image/webp',
}

function imageMediaType(path: string) {
	const extension = path.split('.').pop()?.toLowerCase()
	return extension ? IMAGE_MEDIA_TYPES[extension] : undefined
}

function imageFilename(path: string) {
	return path.split('/').pop() || path
}

function isViewableImagePath(path: string) {
	return path.startsWith('/') && path !== '/'
}

function resolveImagePath(path: string) {
	return path.startsWith('/')
		? pathPosix.normalize(path)
		: pathPosix.resolve('/', path)
}

const viewImageOutputSchema = z.object({
	path: z.string(),
	filename: z.string(),
	mediaType: z.string(),
})

export const viewImageTool = tool({
	description: [
		'View an image stored in the Obsidian vault or agent temporary directory.',
		'Use this tool when you need to inspect an image file visually.',
		`Input an absolute virtual image path or a path relative to ${VAULT_MOUNT_POINT}, with a supported extension: avif, bmp, gif, ico, jpeg, jpg, png, svg, or webp.`,
	].join(' '),
	inputSchema: z.object({
		path: z
			.string()
			.check(
				z.describe(
					`The image path in the virtual filesystem; relative paths resolve from ${VAULT_MOUNT_POINT}.`,
				),
				z.trim(),
				z.minLength(
					1,
					i18n.t('chatbox.errors.toolFieldRequired', { field: 'path' }),
				),
			),
	}),
	contextSchema: z.object({
		app: appDep,
		fileSystemManager: fileSystemManagerDep,
		readTracker: readTrackerDep,
		viewImageAttachments: viewImageAttachmentsDep,
	}),
	outputSchema: viewImageOutputSchema,
	execute: async ({ path }, { context, toolCallId }) => {
		const normalizedPath = resolveImagePath(path)
		if (!isViewableImagePath(normalizedPath)) {
			throw new Error(
				`Image path must be an absolute virtual path or relative to ${VAULT_MOUNT_POINT}: ${path}`,
			)
		}

		const mediaType = imageMediaType(normalizedPath)
		if (!mediaType) {
			throw new Error(`Unsupported image file type: ${normalizedPath}`)
		}

		const fs = await createVaultFileSystem(context.app, {
			fileSystemManager: context.fileSystemManager,
			onRead: context.readTracker?.markRead.bind(context.readTracker),
		})
		let data: Uint8Array
		try {
			data = await fs.readFileBuffer(normalizedPath)
		} catch (error) {
			if (error instanceof Error && error.message.includes('ENOENT')) {
				throw new Error(i18n.t('chatbox.errors.fileNotFound', { path }), {
					cause: error,
				})
			}
			throw error
		}
		if (!context.viewImageAttachments) {
			throw new Error('View image attachments are unavailable')
		}
		context.viewImageAttachments.register(toolCallId, {
			type: 'file',
			data: { type: 'data', data },
			filename: imageFilename(normalizedPath),
			mediaType,
		})
		return {
			path: normalizedPath,
			filename: imageFilename(normalizedPath),
			mediaType,
		}
	},
	toModelOutput: ({ output }) => ({
		type: 'text',
		value: `Loaded image ${output.filename} from ${output.path}.`,
	}),
})
