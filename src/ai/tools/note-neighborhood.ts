import { tool } from 'ai'
import { z } from 'zod/mini'
import i18n from '~/i18n'
import { integerValue, resolveCurrentNotePath, resolveNotePath } from './shared'
import { agentIdDep, appDep, sessionDep } from './tool-context'

export interface NoteNeighborhood extends Record<string, unknown> {
	root: string
	depth: number
	adj: Record<string, string[]>
}

type ResolvedLinks = Record<string, Record<string, number>>

function buildUndirectedAdjacency(resolvedLinks: ResolvedLinks) {
	const adjacency = new Map<string, Set<string>>()

	const ensure = (path: string) => {
		if (!adjacency.has(path)) {
			adjacency.set(path, new Set())
		}
		return adjacency.get(path)!
	}

	for (const [source, targets] of Object.entries(resolvedLinks)) {
		const sourceNeighbors = ensure(source)
		for (const target of Object.keys(targets)) {
			sourceNeighbors.add(target)
			ensure(target).add(source)
		}
	}

	return adjacency
}

export function buildNoteNeighborhood(
	resolvedLinks: ResolvedLinks,
	root: string,
	depth: number,
): NoteNeighborhood {
	const normalizedDepth = Math.max(0, Math.floor(depth))
	const fullAdjacency = buildUndirectedAdjacency(resolvedLinks)
	const visited = new Set<string>([root])
	const queue: Array<{ path: string; distance: number }> = [
		{ path: root, distance: 0 },
	]

	while (queue.length > 0) {
		const current = queue.shift()!
		if (current.distance >= normalizedDepth) {
			continue
		}

		const neighbors = [...(fullAdjacency.get(current.path) ?? [])].sort()
		for (const neighbor of neighbors) {
			if (visited.has(neighbor)) {
				continue
			}
			visited.add(neighbor)
			queue.push({
				path: neighbor,
				distance: current.distance + 1,
			})
		}
	}

	const adj = Object.fromEntries(
		[...visited]
			.sort()
			.map((path) => [
				path,
				[...(fullAdjacency.get(path) ?? [])]
					.filter((neighbor) => visited.has(neighbor))
					.sort(),
			]),
	)

	return {
		root,
		depth: normalizedDepth,
		adj,
	}
}

export const noteNeighborhoodTool = tool({
	description:
		'Return an Obsidian-style local knowledge graph neighborhood for a note as a simple adjacency map. Input a note path or link path plus a depth. Output includes the resolved root path, normalized depth, and adj where each key is a note path and each value is the sorted list of related note paths within the returned neighborhood.',
	inputSchema: z.object({
		note: z
			.string()
			.check(
				z.trim(),
				z.minLength(
					1,
					i18n.t('chatbox.errors.toolFieldRequired', { field: 'note' }),
				),
			),
		depth: z._default(integerValue('depth'), 1),
	}),
	contextSchema: z.object({
		app: appDep,
		session: sessionDep,
		agentId: agentIdDep,
	}),
	outputSchema: z.object({
		root: z.string(),
		depth: z.number(),
		adj: z.record(z.string(), z.array(z.string())),
	}),
	execute: async (params, { context }) => {
		const { app, session, agentId } = context
		const root = resolveNotePath(
			app,
			params.note,
			resolveCurrentNotePath({ session, agentId }),
		)
		return buildNoteNeighborhood(
			app.metadataCache.resolvedLinks ?? {},
			root,
			params.depth,
		)
	},
	toModelOutput: ({ output }) => {
		const neighborhood = output
		const entries = Object.entries(neighborhood.adj).map(
			([path, related]) =>
				`- ${path}: ${related.length ? related.join(', ') : 'no related notes'}`,
		)
		return {
			type: 'text',
			value: `Note neighborhood for ${neighborhood.root} at depth ${neighborhood.depth}:\n${entries.join('\n')}`,
		}
	},
})
