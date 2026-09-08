import { normalizePath, TFile, Vault } from 'obsidian'
import type {
	AppUIMessage,
	ChatDisplayBlock,
	ChatDisplayContentBlock,
} from '~/ai/chat/types'
import { v7 as uuidv7 } from 'uuid'
import type { ChatSession } from '~/ai/chat/domain'
import {
	formatUserContext,
	type UserContextItem,
} from '~/ai/chat/context/user-context'
import {
	imageFilePartSrc,
	isImageFilePart,
} from '~/ai/chat/messages/message-utils'
import type { FilePart } from 'ai'
import { projectTimelineMessageGroups } from '~/ai/chat/ui/display-blocks'
import { getUserContextItems } from '~/ai/chat/messages/ui-message'
import { getMasterAgent } from '~/ai/chat/domain'
import i18n from '~/i18n'
import { writeLocalBinary, writeLocalText } from '~/utils/local-vault-io'
import logger from '~/utils/logger'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { formatDuration } from '~/utils/format-duration'

interface ExportSessionParams {
	vault: Vault
	manifestId: string
	manifestVersion: string
	session: ChatSession
	title: string
	includeToolMessages: boolean
}

const MAX_EXPORT_TITLE_BYTES = 200

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

function truncateUtf8(input: string, maxBytes: number) {
	const encoder = new TextEncoder()
	let byteLength = 0
	let result = ''
	for (const character of input) {
		const characterBytes = encoder.encode(character).byteLength
		if (byteLength + characterBytes > maxBytes) break
		result += character
		byteLength += characterBytes
	}
	return result
}

export function sanitizeExportFileName(input: string) {
	const normalized = input
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/^\.+/, '')
		.replace(/[. ]+$/, '')
	const truncated = truncateUtf8(normalized, MAX_EXPORT_TITLE_BYTES).replace(
		/[. ]+$/,
		'',
	)
	return truncated || 'chat-session'
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
			return filePath
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

async function buildMessageContentMarkdown(
	vault: Vault,
	content: ChatDisplayContentBlock['parts'],
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
) {
	const lines: string[] = []
	for (const part of content) {
		if (part.type === 'text') {
			const text = part.text.trim()
			if (text) lines.push(text)
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
	record: AppUIMessage,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
) {
	const userContext = getUserContextItems(record)
	if (!userContext.length) {
		return []
	}
	const lines: string[] = []
	const textContext = userContext.filter(
		(item) => item.type === 'vault-path' || item.type === 'selection',
	)
	if (textContext.length) {
		lines.push(formatUserContext(textContext), '')
	}
	for (const item of userContext) {
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

function getModelLabel(session: ChatSession, record: AppUIMessage) {
	const sessionModel =
		session.model?.providerId && session.model?.modelId
			? `${session.model.providerId}/${session.model.modelId}`
			: undefined
	const metaModel =
		record.metadata?.llm?.modelName || record.metadata?.llm?.modelId
	const metaProvider =
		record.metadata?.llm?.providerName || record.metadata?.llm?.providerId
	return metaModel && metaProvider
		? `${metaProvider}/${metaModel}`
		: metaModel || metaProvider || sessionModel || 'unknown-model'
}

function getBlockHeadingLabel(
	session: ChatSession,
	record: AppUIMessage,
	block: ChatDisplayBlock,
) {
	if (block.kind === 'system-notification') {
		return `🔔 ${i18n.t('chatbox.exportRole.systemNotification')}`
	}
	if (record.role === 'user') {
		return `👤 ${i18n.t('chatbox.exportRole.user')}`
	}
	if (record.role === 'assistant') {
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
			block.parts,
			assetsDirPath,
			assetsMarkdownPrefix,
		)
	}
	if (block.kind === 'reasoning') {
		const text = block.part.text.trim()
		return text ? [`> ${text.replace(/\n/g, '\n> ')}`] : []
	}
	if (block.kind === 'system-notification') {
		return ['```json', JSON.stringify(block.notification, null, 2), '```']
	}
	const lines = [
		`- ${i18n.t('chatbox.exportMeta.toolName')}: \`${block.toolCall.toolName}\``,
		`- ${i18n.t('chatbox.exportMeta.toolCallId')}: \`${block.toolCall.toolCallId}\``,
		...(block.timing
			? [
					`- ${i18n.t('chatbox.exportMeta.duration')}: \`${formatDuration((block.timing.finishedAt ?? Date.now()) - block.timing.startedAt)}\``,
				]
			: []),
	]
	const todos = block.todos
	if (block.toolCall.toolName === 'todowrite' && todos) {
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
	if (block.toolCall.state === 'output-available') {
		lines.push(
			'',
			'```text',
			typeof block.toolCall.output === 'string'
				? block.toolCall.output
				: JSON.stringify(block.toolCall.output, null, 2),
			'```',
		)
	} else if (block.toolCall.state === 'output-error') {
		lines.push('', '```text', block.toolCall.errorText, '```')
	}
	return lines
}

async function buildSessionMarkdown(
	vault: Vault,
	session: ChatSession,
	title: string,
	includeToolMessages: boolean,
	manifestVersion: string,
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
		pluginVersion: i18n.t('chatbox.exportFrontmatter.pluginVersion'),
	}
	const lines: string[] = [
		'---',
		`${toYamlKeyLabel(frontmatter.title)}: ${JSON.stringify(toMarkdownHeadingText(title))}`,
		`${toYamlKeyLabel(frontmatter.sessionId)}: ${JSON.stringify(session.id)}`,
		`${toYamlKeyLabel(frontmatter.exportedAt)}: ${JSON.stringify(new Date().toLocaleString())}`,
		`${toYamlKeyLabel(frontmatter.createdAt)}: ${JSON.stringify(new Date(session.createdAt).toLocaleString())}`,
		`${toYamlKeyLabel(frontmatter.updatedAt)}: ${JSON.stringify(new Date(session.updatedAt).toLocaleString())}`,
		`${toYamlKeyLabel(frontmatter.model)}: ${JSON.stringify(sessionModel || null)}`,
		`${toYamlKeyLabel(frontmatter.includeToolMessages)}: ${includeToolMessages ? 'true' : 'false'}`,
		`${toYamlKeyLabel(frontmatter.pluginVersion)}: ${JSON.stringify(manifestVersion)}`,
		'---',
		'',
		`# ${toMarkdownHeadingText(title)}`,
		'',
	]

	const masterAgent = getMasterAgent(session)
	for (const { message: record, blocks } of projectTimelineMessageGroups(
		masterAgent.timeline,
		masterAgent.toolTimings,
	)) {
		const userContextLines =
			record.role === 'user'
				? await buildUserContextMarkdown(
						vault,
						record,
						assetsDirPath,
						assetsMarkdownPrefix,
					)
				: []
		if (blocks.length === 0) {
			lines.push(
				`### ${record.role === 'user' ? `👤 ${i18n.t('chatbox.exportRole.user')}` : getModelLabel(session, record)}`,
				'',
				`${i18n.t('chatbox.exportMeta.messageTime')}: ${new Date(record.metadata?.createdAt ?? session.createdAt).toLocaleString()}`,
				'',
			)
			if (userContextLines.length > 0) {
				lines.push(...userContextLines)
			} else {
				lines.push(i18n.t('chatbox.exportMeta.emptyContent'), '')
			}
			continue
		}
		let appendedUserContext = false
		for (const block of blocks) {
			if (!includeToolMessages && block.kind === 'tool-call') {
				continue
			}
			lines.push(`### ${getBlockHeadingLabel(session, record, block)}`, '')
			lines.push(
				`${i18n.t('chatbox.exportMeta.messageTime')}: ${new Date(record.metadata?.createdAt ?? session.createdAt).toLocaleString()}`,
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
			if (!appendedUserContext && userContextLines.length > 0) {
				lines.push(...userContextLines)
				appendedUserContext = true
			}
			if (blockLines.length === 0 && record.role !== 'assistant') {
				if (!appendedUserContext) {
					lines.push(i18n.t('chatbox.exportMeta.emptyContent'), '')
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
	const filePath = resolveUniqueExportPath(
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
		params.manifestVersion,
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
