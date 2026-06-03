import { normalizePath, TFile, Vault } from 'obsidian'
import { v7 as uuidv7 } from 'uuid'
import type { AIMessageContentPart, AISession } from '~/ai/types'
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

function messageToText(content: AIMessageContentPart[] | null | undefined) {
	if (!content) return ''
	return content
		.filter(
			(part): part is Extract<AIMessageContentPart, { type: 'text' }> =>
				part.type === 'text',
		)
		.map((part) => part.text)
		.join('\n')
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

async function resolveImageArrayBuffer(
	imagePart: Extract<AIMessageContentPart, { type: 'image_url' }>,
) {
	const response = await fetch(imagePart.image_url.url)
	if (!response.ok) {
		throw new Error(`Unable to read image content: ${response.status}`)
	}
	return {
		arrayBuffer: await response.arrayBuffer(),
		mimeType:
			response.headers.get('content-type') ||
			detectMimeTypeFromDataUrl(imagePart.image_url.url),
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
	part: Extract<AIMessageContentPart, { type: 'image_url' }>,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
) {
	try {
		const { arrayBuffer, mimeType } = await resolveImageArrayBuffer(part)
		await mkdirsVault(vault, assetsDirPath)
		const ext = mimeType
			? imageExtFromMimeType(mimeType)
			: detectImageExtensionFromUrl(part.image_url.url)
		const fileName = `${uuidv7()}.${ext}`
		const filePath = normalizePath(`${assetsDirPath}/${fileName}`)
		await writeLocalBinary(vault, filePath, arrayBuffer)
		return `${assetsMarkdownPrefix}/${fileName}`
	} catch (error) {
		logger.warn('Failed to persist export image, using source URL', error)
		return part.image_url.url
	}
}

async function buildMessageContentMarkdown(
	vault: Vault,
	content: AIMessageContentPart[],
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
		if (part.type !== 'image_url') continue
		const imageRef = await saveExportImage(
			vault,
			part,
			assetsDirPath,
			assetsMarkdownPrefix,
		)
		lines.push(`![](${imageRef})`)
	}
	return lines
}

function findNextMatchingToolMessage(
	messages: AISession['fragments'][number]['messages'],
	afterIndex: number,
	toolCallId: string,
	consumedToolMessageIds: Set<string>,
) {
	for (let index = afterIndex + 1; index < messages.length; index += 1) {
		const candidate = messages[index]
		if (consumedToolMessageIds.has(candidate.id)) continue
		if (candidate.message.role !== 'tool') continue
		if (candidate.message.tool_call_id !== toolCallId) continue
		return candidate
	}
	return undefined
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
		const consumedToolMessageIds = new Set<string>()
		if (fragmentIndex > 0) {
			lines.push('---', '')
		}
		for (
			let messageIndex = 0;
			messageIndex < fragment.messages.length;
			messageIndex += 1
		) {
			const record = fragment.messages[messageIndex]
			const role = record.message.role
			const textContent = messageToText(record.message.content).trim()
			const hasImageContent = (record.message.content || []).some(
				(part): part is Extract<AIMessageContentPart, { type: 'image_url' }> =>
					part.type === 'image_url',
			)
			if (role === 'system') continue
			if (role === 'tool' && !includeToolMessages) continue
			if (role === 'tool' && includeToolMessages) continue
			if (
				role === 'assistant' &&
				!includeToolMessages &&
				!textContent &&
				!hasImageContent &&
				(record.message.tool_calls?.length || 0) > 0
			) {
				continue
			}

			let headingLabel: string
			if (role === 'user') {
				headingLabel = `👤 ${i18n.t('chatbox.exportRole.user')}`
			} else if (role === 'assistant') {
				const metaModel = record.meta?.modelName || record.meta?.modelId
				const metaProvider =
					record.meta?.providerName || record.meta?.providerId
				const modelLabel =
					metaModel && metaProvider
						? `${metaProvider}/${metaModel}`
						: metaModel || metaProvider || sessionModel || 'unknown-model'
				const hasToolCalls = (record.message.tool_calls?.length || 0) > 0
				const assistantEmoji = hasToolCalls ? '🔧' : '🤖'
				headingLabel = `${assistantEmoji} ${modelLabel}`
			} else {
				headingLabel = `🛠 ${i18n.t('chatbox.exportRole.tool')}`
			}

			lines.push(`### ${headingLabel}`, '')
			lines.push(
				`${i18n.t('chatbox.exportMeta.messageTime')}: ${new Date(record.createdAt).toLocaleString()}`,
				'',
			)

			const contentLines = await buildMessageContentMarkdown(
				vault,
				record.message.content || [],
				assetsDirPath,
				assetsMarkdownPrefix,
			)
			if (contentLines.length > 0) {
				lines.push(...contentLines, '')
			} else if (role !== 'assistant') {
				lines.push(i18n.t('chatbox.exportMeta.emptyContent'), '')
			}

			if (role === 'assistant' && includeToolMessages) {
				const toolCalls = record.message.tool_calls || []
				if (toolCalls.length > 0) {
					lines.push(`- ${i18n.t('chatbox.exportMeta.toolCalls')}:`)
					for (const toolCall of toolCalls) {
						const matchingToolMessage = findNextMatchingToolMessage(
							fragment.messages,
							messageIndex,
							toolCall.id,
							consumedToolMessageIds,
						)
						if (
							matchingToolMessage &&
							matchingToolMessage.message.role === 'tool'
						) {
							consumedToolMessageIds.add(matchingToolMessage.id)
							lines.push(
								`  - \`${toolCall.function.name}\`: \`${toolCall.id}\``,
								'',
								'```json',
								toolCall.function.arguments || '{}',
								'```',
							)
							lines.push(
								`  - ${i18n.t('chatbox.exportMeta.toolName')}: \`${matchingToolMessage.message.name}\``,
								`  - ${i18n.t('chatbox.exportMeta.toolCallId')}: \`${matchingToolMessage.message.tool_call_id}\``,
								'',
							)
							const toolContentLines = await buildMessageContentMarkdown(
								vault,
								matchingToolMessage.message.content || [],
								assetsDirPath,
								assetsMarkdownPrefix,
							)
							if (toolContentLines.length > 0) {
								lines.push(...toolContentLines, '')
							} else {
								lines.push(i18n.t('chatbox.exportMeta.emptyContent'), '')
							}
						} else {
							lines.push(
								`  - \`${toolCall.function.name}\`: \`${toolCall.id}\``,
								'',
								'```json',
								toolCall.function.arguments || '{}',
								'```',
							)
						}
					}
					lines.push('')
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
