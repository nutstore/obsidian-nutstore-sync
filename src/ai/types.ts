import type {
	ChatMessage as DomainChatMessage,
	ChatMessageContentPart as DomainChatMessageContentPart,
	ChatMessageMeta as DomainChatMessageMeta,
	ChatMessageRecord as DomainChatMessageRecord,
	ChatSession as DomainChatSession,
	ChatTaskRecord as DomainChatTaskRecord,
	ChatToolCall as DomainChatToolCall,
	ChatUsage as DomainChatUsage,
} from '~/chat/domain'
import { z } from 'zod'

export const aiModelModalitySchema = z.enum([
	'text',
	'image',
	'audio',
	'video',
	'pdf',
])
export const aiModelCostSchema = z.object({
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
export const aiModelLimitSchema = z.object({
	context: z.number(),
	input: z.number().optional(),
	output: z.number(),
})
export const aiModelProviderOverrideSchema = z.object({
	npm: z.string().optional(),
	api: z.string().optional(),
	shape: z.enum(['completions']).optional(),
})
export const aiModelConfigSchema = z.object({
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
export const aiModelInputSchema = aiModelConfigSchema.partial()
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
	api: z.string().optional(),
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

export const aiProviderConfigSchema = aiProviderDefinitionSchema.extend({
	apiKey: z.string(),
	allowBrowserCors: z.boolean().optional(),
})
export const aiProviderInputSchema = aiProviderConfigSchema.partial().extend({
	models: aiModelInputsSchema.optional(),
})
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

export type AIUsage = DomainChatUsage
export type AITextPart = Extract<DomainChatMessageContentPart, { type: 'text' }>
export type AIImageUrlPart = Extract<
	DomainChatMessageContentPart,
	{ type: 'image_url' }
>
export type AIMessageContentPart = DomainChatMessageContentPart
export type AIToolCall = DomainChatToolCall
export type AIMessage = DomainChatMessage
export type AITaskStatus = DomainChatTaskRecord['status']
export type AIMessageMeta = DomainChatMessageMeta
export type AIMessageRecord = DomainChatMessageRecord
export type AISession = DomainChatSession
export type AITaskRecord = DomainChatTaskRecord

export interface AIToolExecutionContext {
	session: AISession
	depth: number
	maxDepth: number
	parentTaskId?: string
}

export interface ToolExecutionResult {
	result: string | Record<string, unknown>
	reversibleOps?: DomainChatMessageRecord['reversibleOps']
}

export interface AIToolDefinition {
	name: string
	description: string
	inputSchema: z.ZodTypeAny
	execute: (
		params: any,
		context: AIToolExecutionContext,
	) => Promise<ToolExecutionResult>
}
