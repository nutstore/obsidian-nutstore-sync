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
		'Discover notes related to one existing note through Obsidian links. Use this tool when investigating backlinks, outgoing links, nearby graph context, related notes, or notes potentially affected by changes. Use the returned note paths as candidates for subsequent reading. Input one concrete note file or Obsidian link path plus a depth. Do not use it for full-text search, directory enumeration, or note content retrieval.',
	inputSchema: z.object({
		note: z
			.string()
			.check(
				z.describe(
					'An existing note file path or Obsidian link path. Must not be a folder path.',
				),
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
