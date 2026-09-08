import { z } from 'zod/mini'
import type { ChatTodoItem, ReversibleToolOp } from '~/ai/chat/types'

export const aiModelModalitySchema = z.enum([
	'text',
	'image',
	'audio',
	'video',
	'pdf',
	'file',
])
export type AIModelModality = z.infer<typeof aiModelModalitySchema>
export const aiModelCostSchema = z.object({
	input: z.number(),
	output: z.number(),
	cache_read: z.optional(z.number()),
	cache_write: z.optional(z.number()),
	context_over_200k: z.optional(
		z.object({
			input: z.number(),
			output: z.number(),
			cache_read: z.optional(z.number()),
			cache_write: z.optional(z.number()),
		}),
	),
	input_audio: z.optional(z.number()),
	output_audio: z.optional(z.number()),
	reasoning: z.optional(z.number()),
})
export const aiModelLimitSchema = z.object({
	context: z.number(),
	input: z.optional(z.number()),
	output: z.number(),
})
export const aiModelProviderOverrideSchema = z.object({
	npm: z.optional(z.string()),
	api: z.optional(z.string()),
	shape: z.optional(z.string()),
})
export type AIModelProviderOverride = z.infer<
	typeof aiModelProviderOverrideSchema
>
export const aiModelConfigSchema = z.object({
	id: z.string(),
	name: z.string(),
	family: z.optional(z.string()),
	attachment: z.boolean(),
	reasoning: z.boolean(),
	tool_call: z.boolean(),
	structured_output: z.optional(z.boolean()),
	temperature: z.optional(z.boolean()),
	knowledge: z.optional(z.string()),
	release_date: z.string(),
	last_updated: z.string(),
	modalities: z.object({
		input: z.array(aiModelModalitySchema),
		output: z.array(aiModelModalitySchema),
	}),
	open_weights: z.boolean(),
	cost: z.optional(aiModelCostSchema),
	limit: aiModelLimitSchema,
	interleaved: z.optional(
		z.union([
			z.boolean(),
			z.object({
				field: z.string(),
			}),
		]),
	),
	provider: z.optional(aiModelProviderOverrideSchema),
	status: z.optional(z.enum(['alpha', 'beta', 'deprecated'])),
	experimental: z.optional(z.record(z.string(), z.unknown())),
})
export const aiModelInputSchema = z.partial(aiModelConfigSchema)
export type AIModelConfig = z.infer<typeof aiModelConfigSchema>
export type AIModelInput = z.infer<typeof aiModelInputSchema>
export const aiModelConfigsSchema = z.record(z.string(), aiModelConfigSchema)
export const aiModelInputsSchema = z.record(z.string(), aiModelInputSchema)
export type AIModelConfigs = z.infer<typeof aiModelConfigsSchema>
export type AIModelInputs = z.infer<typeof aiModelInputsSchema>

export const aiProviderDefinitionSchema = z.object({
	id: z.string(),
	env: z.array(z.string()),
	npm: z.string(),
	api: z.optional(z.string()),
	name: z.string(),
	doc: z.string(),
	models: aiModelConfigsSchema,
})
export const aiProviderDefinitionsSchema = z.record(
	z.string(),
	aiProviderDefinitionSchema,
)
export type AIProviderDefinition = z.infer<typeof aiProviderDefinitionSchema>
export type AIProviderDefinitions = z.infer<typeof aiProviderDefinitionsSchema>

export const aiProviderConfigSchema = z.extend(aiProviderDefinitionSchema, {
	apiKey: z.string(),
	allowBrowserCors: z.optional(z.boolean()),
})
export const aiProviderInputSchema = z.extend(
	z.partial(aiProviderConfigSchema),
	{
		models: z.optional(aiModelInputsSchema),
	},
)
export const aiProviderConfigsSchema = z.record(
	z.string(),
	aiProviderConfigSchema,
)
export const aiProviderInputsSchema = z.record(
	z.string(),
	aiProviderInputSchema,
)
export type AIProviderConfig = z.infer<typeof aiProviderConfigSchema>
export type AIProviderInput = z.infer<typeof aiProviderInputSchema>
export type AIProviderConfigs = z.infer<typeof aiProviderConfigsSchema>
export type AIProviderInputs = z.infer<typeof aiProviderInputsSchema>

export interface AppToolMetadata {
	reversibleOps?: ReversibleToolOp[]
	todos?: ChatTodoItem[]
	sessionTitle?: string
}
