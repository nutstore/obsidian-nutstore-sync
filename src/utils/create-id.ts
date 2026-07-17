import { idAgent } from 'id-agent'
import { v7 as uuid } from 'uuid'

export default function createId(prefix: string) {
	return `${prefix}-${uuid()}`
}

export function createUniqueWordId(
	prefix: string,
	exists: (id: string) => boolean,
): string {
	for (let words = 3; ; words += 1) {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const id = idAgent({ prefix, words })
			if (!exists(id)) return id
		}
	}
}
