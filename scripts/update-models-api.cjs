#!/usr/bin/env node

const fs = require('node:fs/promises')
const path = require('node:path')
const { z } = require('zod')

const SOURCE_URL = 'https://models.dev/api.json'
const TARGET_PATH = path.resolve(__dirname, '..', 'src/ai/models-api.json')

const aiModelModalitySchema = z.enum(['text', 'image', 'audio', 'video', 'pdf'])

const aiModelCostSchema = z.object({
	input: z.number(),
	output: z.number(),
	cache_read: z.number().optional(),
	cache_write: z.number().optional(),
	context_over_200k: z
		.object({
			input: z.number(),
			output: z.number(),
			cache_read: z.number().optional(),
			cache_write: z.number().optional(),
		})
		.optional(),
	input_audio: z.number().optional(),
	output_audio: z.number().optional(),
	reasoning: z.number().optional(),
})

const aiModelLimitSchema = z.object({
	context: z.number(),
	input: z.number().optional(),
	output: z.number(),
})

const aiModelProviderOverrideSchema = z.object({
	npm: z.string().optional(),
	api: z.string().optional(),
	shape: z.string().optional(),
})

const aiModelConfigSchema = z.object({
	id: z.string(),
	name: z.string(),
	family: z.string().optional(),
	attachment: z.boolean(),
	reasoning: z.boolean(),
	tool_call: z.boolean(),
	structured_output: z.boolean().optional(),
	temperature: z.boolean().optional(),
	knowledge: z.string().optional(),
	release_date: z.string(),
	last_updated: z.string(),
	modalities: z.object({
		input: z.array(aiModelModalitySchema),
		output: z.array(aiModelModalitySchema),
	}),
	open_weights: z.boolean(),
	cost: aiModelCostSchema.optional(),
	limit: aiModelLimitSchema,
	interleaved: z
		.union([
			z.boolean(),
			z.object({
				field: z.string(),
			}),
		])
		.optional(),
	provider: aiModelProviderOverrideSchema.optional(),
	status: z.enum(['alpha', 'beta', 'deprecated']).optional(),
	experimental: z.record(z.string(), z.unknown()).optional(),
})

const aiModelConfigsSchema = z.record(z.string(), aiModelConfigSchema)

const aiProviderDefinitionSchema = z.object({
	id: z.string(),
	env: z.array(z.string()),
	npm: z.string(),
	api: z.string().optional(),
	name: z.string(),
	doc: z.string(),
	models: aiModelConfigsSchema,
})

const aiProviderDefinitionsSchema = z.record(
	z.string(),
	aiProviderDefinitionSchema,
)

function formatIssuePath(pathSegments) {
	if (!pathSegments || pathSegments.length === 0) {
		return '(root)'
	}
	return pathSegments
		.map((segment) =>
			typeof segment === 'number' ? `[${segment}]` : String(segment),
		)
		.join('.')
		.replace(/\.\[/g, '[')
}

async function fetchCatalog() {
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

async function main() {
	const remoteCatalog = await fetchCatalog()
	const parsed = aiProviderDefinitionsSchema.safeParse(remoteCatalog)

	if (!parsed.success) {
		const details = parsed.error.issues
			.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
			.join('; ')
		throw new Error(`Zod validation failed: ${details}`)
	}

	const output = `${JSON.stringify(parsed.data, null, 2)}\n`
	await fs.writeFile(TARGET_PATH, output, 'utf8')

	console.log(`Updated: ${TARGET_PATH}`)
	console.log(`Providers: ${Object.keys(parsed.data).length}`)
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
