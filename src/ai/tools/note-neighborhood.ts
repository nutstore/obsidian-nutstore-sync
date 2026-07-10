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
