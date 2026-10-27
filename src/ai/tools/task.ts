import { tool } from 'ai'
import { z } from 'zod/mini'
import {
	type AgentDefinition,
	listDispatchableDefinitions,
} from '~/ai/chat/agents/registry'
import i18n from '~/i18n'
import { agentIdDep, sessionDep } from './tool-context'
import type { TaskOrigin } from '~/ai/chat/runtime/master-turn-scheduler'

export interface DispatchTaskParams {
	prompt: string
	subagentType: string
	callerAgentId: string
	sessionId: string
}

export type DispatchTaskFn = (
	params: DispatchTaskParams,
	origin: TaskOrigin,
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
		return [
			'Dispatch work to a specialized subagent in an isolated context.',
			`Available subagent types: ${availableTypes}.`,
			'Returns immediately with a task ID while the subagent continues asynchronously.',
			'The subagent receives only prompt, so include all necessary context.',
			'After dispatching, continue only with work that neither overlaps with this task nor depends on its result.',
			'Otherwise, finish the current response; when the task settles, a durable task-result-ready notification automatically schedules this caller and provides the absolute result file path.',
		].join(' ')
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
		origin: z.custom<TaskOrigin>(),
		dispatchableDefinitions: z.optional(z.custom<readonly AgentDefinition[]>()),
	}),
	outputSchema: taskOutputSchema,
	toModelOutput: ({ output }) => ({
		type: 'text',
		value: `Task dispatched. Task ID: ${output.taskId}. Do not attempt to read the task result yet. Continue only with work that neither overlaps with this task nor depends on its result. Otherwise, finish the current response; task completion automatically schedules this caller with a durable task-result-ready notification. When the notification arrives, the task has completed, failed, or been cancelled; use a tool to read its resultPath.`,
	}),
	execute: async (params, { context }) =>
		context.dispatchTask(
			{
				prompt: params.prompt,
				subagentType: params.subagent_type,
				callerAgentId: context.agentId,
				sessionId: context.session.id,
			},
			context.origin,
		),
})
