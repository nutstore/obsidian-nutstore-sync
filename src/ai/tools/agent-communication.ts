import { tool } from 'ai'
import { z } from 'zod/mini'
import type { TaskOrigin } from '~/ai/chat/runtime/master-turn-scheduler'
import type { ChatAgentStatus } from '~/ai/chat/types'
import { agentIdDep, sessionDep } from './tool-context'

export interface AgentAddress {
	sessionId: string
	agentId: string
	origin: TaskOrigin
}
export type AgentWakeReason =
	'message' | 'task-completed' | 'user-input' | 'timeout' | 'cancelled'
export interface AgentCommunication {
	listAgents(address: AgentAddress): Array<{
		id: string
		type: string
		parent?: string
		status: ChatAgentStatus
	}>
	sendMessage(
		address: AgentAddress,
		target: string,
		message: string,
		followup?: boolean,
	): Promise<{ messageId: string }>
}
const contextSchema = z.object({
	session: sessionDep,
	agentId: agentIdDep,
	origin: z.custom<TaskOrigin>(),
	communication: z.custom<AgentCommunication>(),
})
function address(context: z.infer<typeof contextSchema>): AgentAddress {
	return {
		sessionId: context.session.id,
		agentId: context.agentId,
		origin: context.origin,
	}
}
const messageSchema = z.object({
	target: z.string().check(z.trim(), z.minLength(1)),
	message: z.string().check(z.trim(), z.minLength(1)),
})
export const agentCommunicationTools = {
	list_agents: tool({
		description:
			'List agent IDs, types, parents and execution states in this session. Contexts remain isolated.',
		inputSchema: z.object({}),
		contextSchema,
		execute: (_, { context }) =>
			context.communication.listAgents(address(context)),
	}),
	send_message: tool({
		description:
			'Queue a message for another agent in this session. A running agent receives it at the next safe model boundary. This does not start a turn for an idle agent or restart a completed, failed or cancelled agent; the durable message remains in its inbox until a later turn.',
		inputSchema: messageSchema,
		contextSchema,
		execute: ({ target, message }, { context }) =>
			context.communication.sendMessage(address(context), target, message),
	}),
	followup_task: tool({
		description:
			'Queue an instruction and ensure an existing subagent runs. A running agent receives it at the next safe model boundary, a waiting or idle agent resumes, and a completed, failed or cancelled agent starts a new execution. The subagent keeps its existing context and model. The master cannot be targeted.',
		inputSchema: messageSchema,
		contextSchema,
		execute: ({ target, message }, { context }) =>
			context.communication.sendMessage(
				address(context),
				target,
				message,
				true,
			),
	}),
}
