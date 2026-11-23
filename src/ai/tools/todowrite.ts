import { tool } from 'ai'
import * as z from 'zod/mini'
import type { ChatSession } from '~/ai/chat/domain'
import { findLatestTodos } from '~/ai/chat/domain'
import { chatTodoItemSchema, type ChatTodoItem } from '~/ai/chat/types'
import { recordMetadataDep, sessionDep } from './tool-context'

export const todoWriteInputSchema = z.object({
	todos: z.optional(z.array(chatTodoItemSchema)),
})

export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>

function normalizeTodoList(inputTodos: NonNullable<TodoWriteInput['todos']>) {
	return inputTodos.map((input): ChatTodoItem => ({
		content: input.content,
		status: input.status,
		priority: input.priority,
	}))
}

export async function executeTodoWrite(
	params: TodoWriteInput,
	session: ChatSession,
) {
	if (!params.todos) {
		const todos = findLatestTodos(session)
		return { todos }
	}

	const todos = normalizeTodoList(params.todos)
	return { todos }
}

export const todoWriteTool = tool({
	description: [
		'Query (omit todos) or replace (pass full todos array) the session todo list.',
		'Use for tasks with >3 steps, planning, or explicit user tracking; skip single-step tasks or simple lookups.',
		'Keep at most one item in_progress, mark items completed immediately, and do not batch-complete at the end.',
	].join(' '),
	inputSchema: todoWriteInputSchema,
	contextSchema: z.object({
		session: sessionDep,
		recordMetadata: recordMetadataDep,
	}),
	outputSchema: z.object({ todos: z.array(chatTodoItemSchema) }),
	execute: async (params, { context, toolCallId }) => {
		const output = await executeTodoWrite(params, context.session)
		context.recordMetadata?.(toolCallId, { todos: output.todos })
		return output
	},
	toModelOutput: ({ output }) => {
		const { todos } = output
		if (!todos?.length) {
			return { type: 'text', value: 'The todo list is empty.' }
		}
		return {
			type: 'text',
			value: `Todo list:\n${todos
				.map((todo) => `- [${todo.status}] ${todo.content} (${todo.priority})`)
				.join('\n')}`,
		}
	},
})
