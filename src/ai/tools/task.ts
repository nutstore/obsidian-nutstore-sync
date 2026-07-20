import { tool } from 'ai'
import { z } from 'zod/mini'
import {
	type AgentDefinition,
	listDispatchableDefinitions,
} from '~/ai/chat/agents/registry'
import i18n from '~/i18n'
import { agentIdDep, sessionDep } from './tool-context'

export interface DispatchTaskParams {
	prompt: string
	subagentType: string
	callerAgentId: string
	sessionId: string
}

export type DispatchTaskFn = (
	params: DispatchTaskParams,
) => Promise<DispatchTaskResult>

const taskOutputSchema = z.object({
	taskId: z.string(),
	subagentType: z.string(),
	status: z.literal('dispatched'),
})

export type DispatchTaskResult = z.infer<typeof taskOutputSchema>

export const taskTool = tool({
	description: ({
		context,
	}: {
		context: { dispatchableDefinitions?: readonly AgentDefinition[] }
	}) => {
		const availableTypes = (
			context.dispatchableDefinitions ?? listDispatchableDefinitions()
		)
			.map((definition) => `${definition.id}: ${definition.description}`)
			.join('; ')
		return `Dispatch work to a specialized subagent in an isolated context. Available subagent types: ${availableTypes}. Returns immediately with a task ID while the subagent continues asynchronously. The subagent receives only prompt, so include all necessary context. After dispatching, continue only with non-overlapping work or stop and wait. When the task finishes, a task-result-ready system notification provides the absolute result file path under /tmp; use bash to read that file.`
	},
	inputSchema: z.object({
		subagent_type: z.string().check(
			z.trim(),
			z.minLength(
				1,
				i18n.t('chatbox.errors.toolFieldRequired', {
					field: 'subagent_type',
				}),
			),
		),
		prompt: z
			.string()
			.check(
				z.trim(),
				z.minLength(
					1,
					i18n.t('chatbox.errors.toolFieldRequired', { field: 'prompt' }),
				),
			),
	}),
	contextSchema: z.object({
		session: sessionDep,
		agentId: agentIdDep,
		dispatchTask: z.custom<DispatchTaskFn>(),
		dispatchableDefinitions: z.optional(z.custom<readonly AgentDefinition[]>()),
	}),
	outputSchema: taskOutputSchema,
	toModelOutput: ({ output }) => ({
		type: 'text',
		value: `Task dispatched. Task ID: ${output.taskId}. Continue only with non-overlapping work or wait. Do not expect the task result yet. When a task-result-ready system notification arrives, use bash to read its resultPath.`,
	}),
	execute: async (params, { context }) =>
		context.dispatchTask({
			prompt: params.prompt,
			subagentType: params.subagent_type,
			callerAgentId: context.agentId,
			sessionId: context.session.id,
		}),
})
