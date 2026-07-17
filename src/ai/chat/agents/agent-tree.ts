import type { ChatAgentState } from '~/ai/chat/types'

export function findAgent(
	root: ChatAgentState,
	agentId: string,
): ChatAgentState | undefined {
	if (root.id === agentId) return root
	for (const child of Object.values(root.subagents)) {
		const found = findAgent(child, agentId)
		if (found) return found
	}
	return undefined
}

export function findParentAgent(
	root: ChatAgentState,
	childId: string,
): ChatAgentState | undefined {
	if (root.subagents[childId]) return root
	for (const child of Object.values(root.subagents)) {
		const found = findParentAgent(child, childId)
		if (found) return found
	}
	return undefined
}

export function getAgentDepth(root: ChatAgentState, agentId: string): number {
	function search(
		agent: ChatAgentState,
		currentDepth: number,
	): number | undefined {
		if (agent.id === agentId) return currentDepth
		for (const child of Object.values(agent.subagents)) {
			const found = search(child, currentDepth + 1)
			if (found !== undefined) return found
		}
		return undefined
	}
	return search(root, 0) ?? 0
}
