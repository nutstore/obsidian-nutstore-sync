import type { ChatSession } from '~/ai/chat/domain'

import { z } from 'zod/mini'
import { findLatestTodos } from '~/ai/chat/domain'
import { chatTodoItemSchema, type ChatTodoItem } from '~/ai/chat/types'

export const todoWriteInputSchema = z.object({
	todos: z.optional(z.array(chatTodoItemSchema)),
})

export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>

function normalizeTodoList(inputTodos: NonNullable<TodoWriteInput['todos']>) {
	return inputTodos.map(
		(input): ChatTodoItem => ({
			content: input.content,
			status: input.status,
			priority: input.priority,
		}),
	)
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
