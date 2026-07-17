import { tool, type ToolExecutionOptions } from 'ai'
import { z } from 'zod/mini'
import type { AppToolContext } from '~/ai/core/types'
import {
	listDispatchableDefinitions,
	type AgentDefinition,
} from '~/ai/chat/agents/registry'
import i18n from '~/i18n'

export interface DispatchTaskParams {
	prompt: string
	subagentType: string
	callerAgentId: string
	sessionId: string
}

const taskOutputSchema = z.object({
	taskId: z.string(),
	subagentType: z.string(),
	status: z.literal('dispatched'),
})

export type DispatchTaskResult = z.infer<typeof taskOutputSchema>

export interface CreateTaskToolOptions {
	dispatchTask: (params: DispatchTaskParams) => Promise<DispatchTaskResult>
	dispatchableDefinitions?: readonly AgentDefinition[]
}

export function createTaskTool({
	dispatchTask,
	dispatchableDefinitions,
}: CreateTaskToolOptions) {
	const availableTypes = (
		dispatchableDefinitions ?? listDispatchableDefinitions()
	)
		.map((definition) => `${definition.id}: ${definition.description}`)
		.join('; ')

	return tool({
		description: `Dispatch work to a specialized subagent in an isolated context. Available subagent types: ${availableTypes}. Returns immediately with a task ID while the subagent continues asynchronously. The subagent receives only prompt, so include all necessary context. After dispatching, continue only with non-overlapping work or stop and wait. When the task finishes, a task-result-ready system notification provides the absolute result file path under /tmp; use bash to read that file.`,
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
		outputSchema: taskOutputSchema,
		toModelOutput: ({ output }) => ({
			type: 'text',
			value: `Task dispatched. Task ID: ${output.taskId}. Continue only with non-overlapping work or wait. Do not expect the task result yet. When a task-result-ready system notification arrives, use bash to read its resultPath.`,
		}),
		execute: async (
			params,
			{ context }: ToolExecutionOptions<AppToolContext>,
		) =>
			dispatchTask({
				prompt: params.prompt,
				subagentType: params.subagent_type,
				callerAgentId: context.agentId,
				sessionId: context.session.id,
			}),
	})
}
