function decodeURIComponentRepeatedly(value: string): string {
	let current = value.trim()
	for (let i = 0; i < 3; i += 1) {
		try {
			const decoded = decodeURIComponent(current)
			if (decoded === current) break
			current = decoded
		} catch {
			break
		}
	}
	return current
}

function normalizeDroppedPath(path: string): string | null {
	const decoded = decodeURIComponentRepeatedly(path)
		.replace(/^\[\[/, '')
		.replace(/\]\]$/, '')
	const withoutAlias = decoded.split('|')[0]?.trim() ?? ''
	const normalized = withoutAlias.replace(/^\/+/, '').replace(/\/+$/, '').trim()
	return normalized || null
}

function addDroppedJsonPayload(value: unknown, parsed: Set<string>) {
	if (typeof value === 'string') {
		const normalized = normalizeDroppedPath(value)
		if (normalized) parsed.add(normalized)
		return
	}
	if (Array.isArray(value)) {
		for (const item of value) addDroppedJsonPayload(item, parsed)
		return
	}
	if (!value || typeof value !== 'object') return
	const record = value as Record<string, unknown>
	for (const key of ['path', 'file', 'files']) {
		if (key in record) addDroppedJsonPayload(record[key], parsed)
	}
}

function addDroppedPathPayload(payload: string, parsed: Set<string>) {
	const trimmedPayload = payload.trim()
	if (!trimmedPayload) return
	if (trimmedPayload.startsWith('{') || trimmedPayload.startsWith('[')) {
		try {
			addDroppedJsonPayload(JSON.parse(trimmedPayload), parsed)
			return
		} catch {
			// Fall through to plain text parsing.
		}
	}
	for (const line of trimmedPayload.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('http')) {
			continue
		}
		if (trimmed.startsWith('obsidian://open?')) {
			try {
				const url = new URL(trimmed)
				const file = url.searchParams.get('file')
				if (file) {
					const normalized = normalizeDroppedPath(file)
					if (normalized) parsed.add(normalized)
				}
				continue
			} catch {
				// Fall through to plain path parsing.
			}
		}
		const normalized = normalizeDroppedPath(trimmed)
		if (normalized) parsed.add(normalized)
	}
}

export function parseDroppedObsidianPaths(e: DragEvent): string[] {
	const parsed = new Set<string>()
	const dataTransfer = e.dataTransfer
	if (!dataTransfer) return []
	for (const type of Array.from(dataTransfer.types)) {
		if (type === 'Files') continue
		addDroppedPathPayload(dataTransfer.getData(type) ?? '', parsed)
	}
	return Array.from(parsed)
}

export interface DropRoute {
	paths: string[]
	files: File[]
}

export function decideDropRoute(event: DragEvent): DropRoute {
	const paths = parseDroppedObsidianPaths(event)
	if (paths.length > 0) {
		return { paths, files: [] }
	}
	const files = Array.from(event.dataTransfer?.files ?? [])
	return { paths: [], files }
}

export function hasDragItems(event: DragEvent) {
	const items = event.dataTransfer?.items
	if (!items) return false
	for (let i = 0; i < items.length; i += 1) {
		const item = items[i]
		if (item.kind === 'file' || item.kind === 'string') {
			return true
		}
	}
	return false
}
