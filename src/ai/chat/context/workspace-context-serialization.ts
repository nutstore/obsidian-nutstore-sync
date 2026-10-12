import { encode } from '@toon-format/toon'
import type { WorkspaceContextDelta } from '~/ai/chat/types'
import type { MemoryEntry } from '~/ai/memory/memory-note'

/**
 * Storage retains deltas and hashes; the model receives only changed values.
 * Memory IDs remain usable by the memory tool, but appear only once per row.
 * Missing fields mean unchanged; null and empty arrays are explicit updates.
 */
export function serializeWorkspaceContext(
	deltas: WorkspaceContextDelta[],
): string {
	const fields: Record<string, unknown> = Object.create(null)
	const additions: MemoryEntry[] = []
	for (const entry of deltas) {
		if (!entry.key.startsWith('memory:')) {
			fields[entry.key] = entry.content
			continue
		}
		const memory = entry.content as MemoryEntry
		additions.push({ id: memory.id, text: memory.text })
	}
	if (additions.length) fields.memoryAdditions = additions
	return `<AdditionalContext>\n${encode(fields)}\n</AdditionalContext>`
}
