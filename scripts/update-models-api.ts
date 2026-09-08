#!/usr/bin/env jiti

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	aiProviderDefinitionsSchema,
	type AIProviderDefinitions,
} from '../src/ai/core/types.ts'

const SOURCE_URL = 'https://models.dev/api.json'
const TARGET_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'src/ai/models-api.json',
)

export const INCLUDED_PROVIDER_IDS = new Set([
	'alibaba-cn',
	'alibaba',
	'anthropic',
	'azure',
	'cloudflare-workers-ai',
	'deepseek',
	'google',
	'groq',
	'huggingface',
	'minimax-cn',
	'minimax',
	'moonshotai-cn',
	'moonshotai',
	'nvidia',
	'openai',
	'openrouter',
	'siliconflow-cn',
	'siliconflow',
	'togetherai',
	'xai',
	'xiaomi-token-plan-ams',
	'xiaomi-token-plan-cn',
	'xiaomi-token-plan-sgp',
	'xiaomi',
	'zhipuai',
])

function formatIssuePath(pathSegments: PropertyKey[]) {
	if (pathSegments.length === 0) {
		return '(root)'
	}
	return pathSegments
		.map((segment) =>
			typeof segment === 'number' ? `[${segment}]` : String(segment),
		)
		.join('.')
		.replace(/\.\[/g, '[')
}

async function fetchCatalog(): Promise<unknown> {
	const response = await fetch(SOURCE_URL, {
		headers: {
			accept: 'application/json',
		},
	})

	if (!response.ok) {
		throw new Error(
			`Download failed: ${response.status} ${response.statusText}`,
		)
	}

	return response.json()
}

export function filterCatalog(
	catalog: AIProviderDefinitions,
): AIProviderDefinitions {
	return Object.fromEntries(
		Object.entries(catalog).filter(([id]) => INCLUDED_PROVIDER_IDS.has(id)),
	)
}

export async function main({ checkOnly = false } = {}) {
	const remoteCatalog = await fetchCatalog()
	const parsed = aiProviderDefinitionsSchema.safeParse(remoteCatalog)

	if (!parsed.success) {
		const details = parsed.error.issues
			.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
			.join('; ')
		throw new Error(`Zod validation failed: ${details}`)
	}

	if (checkOnly) {
		console.log('Validated models.dev catalog schema')
		return
	}

	const filteredCatalog = filterCatalog(parsed.data)
	const output = `${JSON.stringify(filteredCatalog, null, 2)}\n`
	await writeFile(TARGET_PATH, output, 'utf8')

	console.log(`Updated: ${TARGET_PATH}`)
	console.log(`Providers: ${Object.keys(filteredCatalog).length}`)
}

function isMainModule() {
	const invokedPath = process.argv[1]
	return (
		!!invokedPath &&
		path.resolve(invokedPath) === fileURLToPath(import.meta.url)
	)
}

if (isMainModule()) {
	void main({ checkOnly: process.argv.includes('--check') }).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
