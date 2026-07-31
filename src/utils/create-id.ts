import { idAgent } from 'id-agent'
import { v7 as uuid } from 'uuid'

export default function createId(prefix: string) {
	return `${prefix}-${uuid()}`
}

export async function createUniqueWordId(
	prefix: string,
	exists: (id: string) => boolean | Promise<boolean>,
): Promise<string> {
	for (let words = 3; ; words += 1) {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const id = idAgent({ prefix, words })
			if (!(await exists(id))) return id
		}
	}
}
