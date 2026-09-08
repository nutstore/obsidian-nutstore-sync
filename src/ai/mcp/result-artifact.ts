import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { toUint8Array } from 'js-base64'
import type { App } from 'obsidian'
import { BASH_TMP_MOUNT_POINT } from '~/ai/tools/bash/mount-points'
import {
	existsBashTmpPath,
	writeBashTmpBinary,
	writeBashTmpText,
} from '~/ai/tools/bash/tmp-fs'
import { createUniqueWordId } from '~/utils/create-id'

interface McpToolResult {
	content: ContentBlock[]
	isError?: boolean
	structuredContent?: Record<string, unknown>
}

interface SaveMcpToolResultOptions {
	sessionId: string
	serverName: string
	toolName: string
	result: unknown
}

const MAX_INLINE_MCP_OUTPUT_CHARS = 20 * 1024

const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
	'application/json': 'json',
	'application/pdf': 'pdf',
	'application/xml': 'xml',
	'audio/flac': 'flac',
	'audio/m4a': 'm4a',
	'audio/mpeg': 'mp3',
	'audio/ogg': 'ogg',
	'audio/wav': 'wav',
	'image/avif': 'avif',
	'image/bmp': 'bmp',
	'image/gif': 'gif',
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/svg+xml': 'svg',
	'image/webp': 'webp',
	'text/csv': 'csv',
	'text/html': 'html',
	'text/markdown': 'md',
	'text/plain': 'txt',
}

export async function formatMcpToolResult(
	app: App,
	options: SaveMcpToolResultOptions,
) {
	const inlineResult = formatInlineResult(options.result)
	if (isMcpToolResult(options.result) && options.result.isError === true) {
		return `MCP tool returned an error:\n\n${inlineResult}`
	}
	if (
		!hasBinaryContent(options.result) &&
		inlineResult.length <= MAX_INLINE_MCP_OUTPUT_CHARS
	) {
		return inlineResult
	}

	const resultPath = await saveMcpToolResult(app, options)
	return `MCP tool result saved to ${resultPath}. Read the Markdown manifest with bash, then inspect referenced files as needed; use view_image for images.`
}

async function saveMcpToolResult(app: App, options: SaveMcpToolResultOptions) {
	const resultId = await createUniqueWordId('mcp', (id) =>
		existsBashTmpPath(
			app,
			`${BASH_TMP_MOUNT_POINT}/${options.sessionId}/mcp/${id}`,
		),
	)
	const resultDir = `${BASH_TMP_MOUNT_POINT}/${options.sessionId}/mcp/${resultId}`
	const resultPath = `${resultDir}/result.md`
	const lines = [
		'# MCP tool result',
		'',
		`- Server: ${inlineCode(options.serverName)}`,
		`- Tool: ${inlineCode(options.toolName)}`,
	]

	if (!isMcpToolResult(options.result)) {
		lines.push('', '## Raw result', '', fencedJson(options.result))
		await writeBashTmpText(app, resultPath, `${lines.join('\n')}\n`)
		return resultPath
	}

	if (options.result.isError !== undefined) {
		lines.push(`- Error: ${options.result.isError ? 'yes' : 'no'}`)
	}
	if (options.result.structuredContent !== undefined) {
		lines.push(
			'',
			'## Structured content',
			'',
			fencedJson(options.result.structuredContent),
		)
	}

	for (const [index, part] of options.result.content.entries()) {
		lines.push('', `## Content ${index + 1}: ${contentLabel(part)}`, '')
		await appendContent(app, resultDir, index + 1, part, lines)
	}

	await writeBashTmpText(app, resultPath, `${lines.join('\n')}\n`)
	return resultPath
}

function formatInlineResult(result: unknown) {
	if (!isMcpToolResult(result)) {
		return JSON.stringify(result, null, 2) ?? String(result)
	}

	const sections: string[] = []
	if (result.structuredContent !== undefined) {
		sections.push(JSON.stringify(result.structuredContent, null, 2))
	}
	for (const part of result.content) {
		switch (part.type) {
			case 'text':
				sections.push(part.text)
				break
			case 'resource_link':
				sections.push(JSON.stringify(part, null, 2))
				break
			case 'resource':
				sections.push(
					'text' in part.resource
						? `Embedded resource ${part.resource.uri}:\n${part.resource.text}`
						: `Embedded binary resource: ${part.resource.uri} (${part.resource.mimeType ?? 'unknown MIME type'})`,
				)
				break
			case 'image':
			case 'audio':
				sections.push(
					`${part.type} content (${part.mimeType}) omitted from inline output`,
				)
		}
	}
	return sections.join('\n\n') || JSON.stringify(result, null, 2)
}

function hasBinaryContent(result: unknown) {
	return (
		isMcpToolResult(result) &&
		result.content.some(
			(part) =>
				part.type === 'image' ||
				part.type === 'audio' ||
				(part.type === 'resource' && 'blob' in part.resource),
		)
	)
}

function isMcpToolResult(result: unknown): result is McpToolResult {
	return (
		result !== null &&
		typeof result === 'object' &&
		'content' in result &&
		Array.isArray(result.content)
	)
}

async function appendContent(
	app: App,
	resultDir: string,
	index: number,
	part: ContentBlock,
	lines: string[],
) {
	switch (part.type) {
		case 'text':
			lines.push(fencedText(part.text))
			return
		case 'image':
		case 'audio': {
			const path = `${resultDir}/${part.type}-${index}.${mediaExtension(
				part.mimeType,
			)}`
			await writeBashTmpBinary(app, path, toUint8Array(part.data))
			lines.push(
				`- Path: ${inlineCode(path)}`,
				`- MIME type: ${inlineCode(part.mimeType)}`,
			)
			return
		}
		case 'resource_link':
			lines.push(fencedJson(part))
			return
		case 'resource': {
			const { resource } = part
			lines.push(
				`- URI: ${inlineCode(resource.uri)}`,
				`- MIME type: ${inlineCode(resource.mimeType ?? 'unknown')}`,
			)
			if ('text' in resource) {
				lines.push('', fencedText(resource.text))
				return
			}
			const path = `${resultDir}/resource-${index}.${mediaExtension(
				resource.mimeType,
			)}`
			await writeBashTmpBinary(app, path, toUint8Array(resource.blob))
			lines.push(`- Path: ${inlineCode(path)}`)
		}
	}
}

function contentLabel(part: ContentBlock) {
	switch (part.type) {
		case 'resource_link':
			return 'resource link'
		case 'resource':
			return 'embedded resource'
		default:
			return part.type
	}
}

function mediaExtension(mediaType?: string) {
	if (!mediaType) {
		return 'bin'
	}
	const normalized = mediaType.toLowerCase().split(';', 1)[0].trim()
	const known = MEDIA_TYPE_EXTENSIONS[normalized]
	if (known) {
		return known
	}
	const subtype = normalized.split('/', 2)[1]
	const safeSubtype = subtype?.replace(/\+xml$/, '').replace(/[^a-z0-9]+/g, '')
	return safeSubtype || 'bin'
}

function inlineCode(value: string) {
	const longestFence = longestBacktickRun(value)
	const fence = '`'.repeat(longestFence + 1)
	return `${fence}${value}${fence}`
}

function fencedText(value: string) {
	return fenced(value, 'text')
}

function fencedJson(value: unknown) {
	return fenced(JSON.stringify(value, null, 2) ?? String(value), 'json')
}

function fenced(value: string, language: string) {
	const fence = '`'.repeat(Math.max(3, longestBacktickRun(value) + 1))
	return `${fence}${language}\n${value}\n${fence}`
}

function longestBacktickRun(value: string) {
	return Math.max(
		0,
		...[...value.matchAll(/`+/g)].map((match) => match[0].length),
	)
}
