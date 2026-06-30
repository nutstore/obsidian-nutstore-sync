import { normalizePath, TFile, Vault } from 'obsidian'
import type { ChatDisplayBlock, ChatMessageRecord } from '~/ai/chat/types'
import { v7 as uuidv7 } from 'uuid'
import type { AISession } from '~/ai/core/types'
import {
	formatUserContext,
	type UserContextItem,
} from '~/ai/chat/context/user-context'
import {
	imageFilePartSrc,
	isImageFilePart,
} from '~/ai/chat/messages/message-utils'
import type { FilePart } from 'ai'
import { projectFragmentMessageGroups } from '~/ai/chat/ui/display-blocks'
import i18n from '~/i18n'
import { writeLocalBinary, writeLocalText } from '~/utils/local-vault-io'
import logger from '~/utils/logger'
import { mkdirsVault } from '~/utils/mkdirs-vault'

interface ExportSessionParams {
	vault: Vault
	manifestId: string
	session: AISession
	title: string
	includeToolMessages: boolean
}

function formatExportTimestamp(date: Date) {
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function formatAssetsDirectory(date: Date) {
	const pad = (value: number) => String(value).padStart(2, '0')
	return normalizePath(
		`assets/${date.getFullYear()}/${pad(date.getMonth() + 1)}`,
	)
}

function sanitizeExportFileName(input: string) {
	const normalized = input
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/^\.+/, '')
		.replace(/[. ]+$/, '')
	return normalized || 'chat-session'
}

function toMarkdownHeadingText(value: string) {
	return value.replace(/\r?\n/g, ' ').trim()
}

function toYamlKeyLabel(value: string) {
	return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value)
}

function imageExtFromMimeType(mimeType: string | undefined) {
	switch ((mimeType || '').toLowerCase()) {
		case 'image/png':
			return 'png'
		case 'image/jpeg':
			return 'jpg'
		case 'image/webp':
			return 'webp'
		case 'image/gif':
			return 'gif'
		case 'image/svg+xml':
			return 'svg'
		case 'image/bmp':
			return 'bmp'
		case 'image/x-icon':
		case 'image/vnd.microsoft.icon':
			return 'ico'
		default:
			return 'png'
	}
}

function detectMimeTypeFromDataUrl(url: string) {
	const match = /^data:([^;,]+)[;,]/i.exec(url)
	return match?.[1]?.toLowerCase()
}

function detectImageExtensionFromUrl(url: string) {
	const dataUrlMime = detectMimeTypeFromDataUrl(url)
	if (dataUrlMime) {
		return imageExtFromMimeType(dataUrlMime)
	}
	const cleaned = url.split('?')[0]?.split('#')[0] || ''
	const extMatch = /\.([a-zA-Z0-9]+)$/.exec(cleaned)
	const ext = extMatch?.[1]?.toLowerCase()
	if (!ext) return 'png'
	if (
		['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp', 'ico'].includes(ext)
	) {
		return ext === 'jpeg' ? 'jpg' : ext
	}
	return 'png'
}

async function resolveImageArrayBuffer(imagePart: FilePart) {
	const url = imageFilePartSrc(imagePart)
	if (!url) {
		throw new Error('Unable to read non-URL image content')
	}
	const response = await fetch(url)
	if (!response.ok) {
		throw new Error(`Unable to read image content: ${response.status}`)
	}
	return {
		arrayBuffer: await response.arrayBuffer(),
		mimeType:
			response.headers.get('content-type') || detectMimeTypeFromDataUrl(url),
	}
}

function resolveUniqueExportPath(
	vault: Vault,
	directoryPath: string,
	baseFileName: string,
) {
	let index = 0
	while (true) {
		const suffix = index === 0 ? '' : `-${index + 1}`
		const fileStem = `${baseFileName}${suffix}`
		const filePath = normalizePath(`${directoryPath}/${fileStem}.md`)
		const existing = vault.getAbstractFileByPath(filePath)
		if (!existing) {
			return { filePath, fileStem }
		}
		index += 1
	}
}

async function saveExportImage(
	vault: Vault,
	part: FilePart,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
) {
	const url = imageFilePartSrc(part)
	if (!url) return undefined
	try {
		const { arrayBuffer, mimeType } = await resolveImageArrayBuffer(part)
		await mkdirsVault(vault, assetsDirPath)
		const ext = mimeType
			? imageExtFromMimeType(mimeType)
			: detectImageExtensionFromUrl(url)
		const fileName = `${uuidv7()}.${ext}`
		const filePath = normalizePath(`${assetsDirPath}/${fileName}`)
		await writeLocalBinary(vault, filePath, arrayBuffer)
		return `${assetsMarkdownPrefix}/${fileName}`
	} catch (error) {
		logger.warn('Failed to persist export image, using source URL', error)
		return url
	}
}

async function saveExportUserContextImage(
	vault: Vault,
	item: Extract<UserContextItem, { type: 'image' }>,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
) {
	try {
		await mkdirsVault(vault, assetsDirPath)
		const fileName = `${uuidv7()}.${imageExtFromMimeType(item.mimeType)}`
		const filePath = normalizePath(`${assetsDirPath}/${fileName}`)
		await writeLocalBinary(vault, filePath, await item.blob.arrayBuffer())
		return `${assetsMarkdownPrefix}/${fileName}`
	} catch (error) {
		logger.warn('Failed to persist export image from user context', error)
		return undefined
	}
}

type ExportContentPart = {
	type: string
	text?: string
	data?: unknown
	mediaType?: string
	output?: { type: string; value?: string }
}

async function buildMessageContentMarkdown(
	vault: Vault,
	content: ExportContentPart[],
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
) {
	const lines: string[] = []
	for (const part of content) {
		if (part.type === 'text') {
			const text = (part.text ?? '').trim()
			if (text) lines.push(text)
			continue
		}
		if (part.type === 'reasoning') {
			const text = (part.text ?? '').trim()
			if (text) lines.push(`> ${text.replace(/\n/g, '\n> ')}`)
			continue
		}
		if (part.type === 'tool-result') {
			const value =
				part.output?.type === 'text' ? (part.output.value ?? '') : ''
			if (value.trim()) lines.push(value.trim())
			continue
		}
		if (!isImageFilePart(part)) continue
		const imageRef = await saveExportImage(
			vault,
			part,
			assetsDirPath,
			assetsMarkdownPrefix,
		)
		if (!imageRef) continue
		lines.push(`![](${imageRef})`)
	}
	return lines
}

async function buildUserContextMarkdown(
	vault: Vault,
	record: ChatMessageRecord,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
) {
	if (!record.userContext?.length) {
		return []
	}
	const lines: string[] = []
	const textContext = record.userContext.filter(
		(item) => item.type === 'vault-path' || item.type === 'selection',
	)
	if (textContext.length) {
		lines.push(formatUserContext(textContext), '')
	}
	for (const item of record.userContext) {
		if (item.type === 'image') {
			const imageRef = await saveExportUserContextImage(
				vault,
				item,
				assetsDirPath,
				assetsMarkdownPrefix,
			)
			if (imageRef) {
				lines.push(`![](${imageRef})`, '')
			}
			continue
		}
		if (item.type !== 'file') {
			continue
		}
		const truncated = item.size > 64 * 1024
		const blob = truncated ? item.blob.slice(0, 64 * 1024) : item.blob
		const content = await blob.text()
		lines.push(
			[
				'<UserProvidedFile>',
				JSON.stringify(
					{
						type: 'file',
						filename: item.filename,
						mimeType: item.mimeType,
						size: item.size,
						truncated,
						content,
					},
					null,
					2,
				),
				'</UserProvidedFile>',
			].join('\n'),
			'',
		)
	}
	return lines
}

function getModelLabel(session: AISession, record: ChatMessageRecord) {
	const sessionModel =
		session.model?.providerId && session.model?.modelId
			? `${session.model.providerId}/${session.model.modelId}`
			: undefined
	const metaModel = record.meta?.modelName || record.meta?.modelId
	const metaProvider = record.meta?.providerName || record.meta?.providerId
	return metaModel && metaProvider
		? `${metaProvider}/${metaModel}`
		: metaModel || metaProvider || sessionModel || 'unknown-model'
}

function getBlockHeadingLabel(
	session: AISession,
	record: ChatMessageRecord,
	block: ChatDisplayBlock,
) {
	if (record.message.role === 'user') {
		return `👤 ${i18n.t('chatbox.exportRole.user')}`
	}
	if (record.message.role === 'assistant') {
		const modelLabel = getModelLabel(session, record)
		const emoji = block.kind === 'tool-call' ? '🔧' : '🤖'
		return `${emoji} ${modelLabel}`
	}
	return `🛠 ${i18n.t('chatbox.exportRole.tool')}`
}

async function buildDisplayBlockMarkdown(
	vault: Vault,
	block: ChatDisplayBlock,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
) {
	if (block.kind === 'content') {
		return buildMessageContentMarkdown(
			vault,
			block.parts as unknown as ExportContentPart[],
			assetsDirPath,
			assetsMarkdownPrefix,
		)
	}
	if (block.kind === 'tool-result') {
		const toolMsgContent = Array.isArray(block.toolMessage.message.content)
			? (block.toolMessage.message.content as unknown as ExportContentPart[])
			: []
		return buildMessageContentMarkdown(
			vault,
			toolMsgContent,
			assetsDirPath,
			assetsMarkdownPrefix,
		)
	}
	const lines = [
		`- ${i18n.t('chatbox.exportMeta.toolName')}: \`${block.toolCall.toolName}\``,
		`- ${i18n.t('chatbox.exportMeta.toolCallId')}: \`${block.toolCall.toolCallId}\``,
	]
	const todos = block.toolMessage?.todos
	if (block.toolCall.toolName === 'todowrite' && Array.isArray(todos)) {
		lines.push('')
		for (const todo of todos) {
			const checked =
				todo.status === 'completed'
					? 'x'
					: todo.status === 'cancelled'
						? '-'
						: ' '
			lines.push(`- [${checked}] ${todo.content}`)
		}
		if (todos.length === 0) {
			lines.push(`- ${i18n.t('chatbox.ui.states.todoEmpty')}`)
		}
		return lines
	}
	lines.push(
		'',
		'```json',
		JSON.stringify(block.toolCall.input ?? {}, null, 2),
		'```',
	)
	if (block.toolMessage) {
		const toolContentLines = await buildMessageContentMarkdown(
			vault,
			(Array.isArray(block.toolMessage.message.content)
				? block.toolMessage.message.content
				: []) as unknown as ExportContentPart[],
			assetsDirPath,
			assetsMarkdownPrefix,
		)
		if (toolContentLines.length > 0) {
			lines.push('', ...toolContentLines)
		}
	}
	return lines
}

async function buildSessionMarkdown(
	vault: Vault,
	session: AISession,
	title: string,
	includeToolMessages: boolean,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
) {
	const sessionModel =
		session.model?.providerId && session.model?.modelId
			? `${session.model.providerId}/${session.model.modelId}`
			: undefined
	const frontmatter = {
		title: i18n.t('chatbox.exportFrontmatter.title'),
		sessionId: i18n.t('chatbox.exportFrontmatter.sessionId'),
		exportedAt: i18n.t('chatbox.exportFrontmatter.exportedAt'),
		createdAt: i18n.t('chatbox.exportFrontmatter.createdAt'),
		updatedAt: i18n.t('chatbox.exportFrontmatter.updatedAt'),
		model: i18n.t('chatbox.exportFrontmatter.model'),
		includeToolMessages: i18n.t(
			'chatbox.exportFrontmatter.includeToolMessages',
		),
	}
	const lines: string[] = [
		'---',
		`${toYamlKeyLabel(frontmatter.title)}: ${JSON.stringify(toMarkdownHeadingText(title))}`,
		`${toYamlKeyLabel(frontmatter.exportedAt)}: ${JSON.stringify(new Date().toLocaleString())}`,
		`${toYamlKeyLabel(frontmatter.createdAt)}: ${JSON.stringify(new Date(session.createdAt).toLocaleString())}`,
		`${toYamlKeyLabel(frontmatter.updatedAt)}: ${JSON.stringify(new Date(session.updatedAt).toLocaleString())}`,
		`${toYamlKeyLabel(frontmatter.model)}: ${JSON.stringify(sessionModel || null)}`,
		`${toYamlKeyLabel(frontmatter.includeToolMessages)}: ${includeToolMessages ? 'true' : 'false'}`,
		'---',
		'',
		`# ${toMarkdownHeadingText(title)}`,
		'',
	]

	for (
		let fragmentIndex = 0;
		fragmentIndex < session.fragments.length;
		fragmentIndex += 1
	) {
		const fragment = session.fragments[fragmentIndex]
		if (fragmentIndex > 0) {
			lines.push('---', '')
		}
		for (const { record, blocks } of projectFragmentMessageGroups(
			fragment.messages,
		)) {
			if (blocks.length === 0) {
				lines.push(
					`### ${record.message.role === 'user' ? `👤 ${i18n.t('chatbox.exportRole.user')}` : getModelLabel(session, record)}`,
					'',
					`${i18n.t('chatbox.exportMeta.messageTime')}: ${new Date(record.createdAt).toLocaleString()}`,
					'',
				)
				const contextLines = await buildUserContextMarkdown(
					vault,
					record,
					assetsDirPath,
					assetsMarkdownPrefix,
				)
				if (contextLines.length > 0) {
					lines.push(...contextLines)
				} else {
					lines.push(i18n.t('chatbox.exportMeta.emptyContent'), '')
				}
				continue
			}
			let appendedUserContext = false
			for (const block of blocks) {
				if (
					!includeToolMessages &&
					(block.kind === 'tool-call' || block.kind === 'tool-result')
				) {
					continue
				}
				lines.push(`### ${getBlockHeadingLabel(session, record, block)}`, '')
				lines.push(
					`${i18n.t('chatbox.exportMeta.messageTime')}: ${new Date(record.createdAt).toLocaleString()}`,
					'',
				)
				const blockLines = await buildDisplayBlockMarkdown(
					vault,
					block,
					assetsDirPath,
					assetsMarkdownPrefix,
				)
				if (blockLines.length > 0) {
					lines.push(...blockLines, '')
				}
				if (
					!appendedUserContext &&
					record.message.role === 'user' &&
					record.userContext?.length
				) {
					const contextLines = await buildUserContextMarkdown(
						vault,
						record,
						assetsDirPath,
						assetsMarkdownPrefix,
					)
					if (contextLines.length > 0) {
						lines.push(...contextLines)
						appendedUserContext = true
					}
				}
				if (blockLines.length === 0 && record.message.role !== 'assistant') {
					if (!appendedUserContext) {
						const contextLines = await buildUserContextMarkdown(
							vault,
							record,
							assetsDirPath,
							assetsMarkdownPrefix,
						)
						if (contextLines.length > 0) {
							lines.push(...contextLines)
							appendedUserContext = true
						}
					}
					if (!appendedUserContext) {
						lines.push(i18n.t('chatbox.exportMeta.emptyContent'), '')
					}
				}
			}
		}
	}

	return `${lines.join('\n').trim()}\n`
}

export async function exportSessionToMarkdownFile(params: ExportSessionParams) {
	const exportDirPath = normalizePath(`${params.manifestId}/conversations`)
	await mkdirsVault(params.vault, exportDirPath)
	const exportDate = new Date()
	const baseFileName = `${sanitizeExportFileName(params.title)}-${formatExportTimestamp(exportDate)}`
	const { filePath } = resolveUniqueExportPath(
		params.vault,
		exportDirPath,
		baseFileName,
	)
	const assetsMarkdownPrefix = formatAssetsDirectory(exportDate)
	const assetsDirPath = normalizePath(
		`${exportDirPath}/${assetsMarkdownPrefix}`,
	)
	const markdown = await buildSessionMarkdown(
		params.vault,
		params.session,
		params.title,
		params.includeToolMessages,
		assetsDirPath,
		assetsMarkdownPrefix,
	)
	await writeLocalText(params.vault, filePath, markdown)
	const file = params.vault.getAbstractFileByPath(filePath)
	if (!(file instanceof TFile)) {
		throw new Error(`Unable to locate exported file: ${filePath}`)
	}
	return file
}
