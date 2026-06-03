import type { App, WorkspaceLeaf } from 'obsidian'
import { hash as hashObject } from 'ohash'

import type { ChatMessageRecord, WorkspaceContextDelta } from './domain'

type View = WorkspaceLeaf['view'] & {
	file?: {
		path: string
	}
	containerEl?: HTMLElement
}

function getConnectedFilePath(leaf: WorkspaceLeaf): string | null {
	const view = leaf.view as unknown as View
	if (
		!view?.file?.path ||
		!(
			view.getViewType() in
			['markdown', 'canvas', 'pdf', 'image', 'video', 'audio', 'bases']
		) ||
		!view.containerEl?.isConnected
	) {
		return null
	}
	return view.file.path
}

export function captureWorkspaceContexts(app: App): WorkspaceContextDelta[] {
	const activeFile = app.workspace.getActiveFile()?.path ?? null

	const openFilePaths = new Set<string>()
	app.workspace.iterateAllLeaves((leaf) => {
		const filePath = getConnectedFilePath(leaf)
		if (filePath) {
			openFilePaths.add(filePath)
		}
	})
	const openFiles = Array.from(openFilePaths).sort()
	return [
		{ key: 'activeFile', content: activeFile, hash: hashObject(activeFile) },
		{ key: 'openFiles', content: openFiles, hash: hashObject(openFiles) },
	]
}

export function computeChangedContexts(
	prevMessages: ChatMessageRecord[],
	current: WorkspaceContextDelta[],
): WorkspaceContextDelta[] {
	const lastHashByKey = new Map<string, string>()
	for (let i = prevMessages.length - 1; i >= 0; i--) {
		const ctx = prevMessages[i].workspaceContextDelta
		if (!ctx) continue
		for (const entry of ctx) {
			if (!lastHashByKey.has(entry.key)) {
				lastHashByKey.set(entry.key, entry.hash)
			}
		}
		if (lastHashByKey.size === current.length) break
	}
	return current.filter((entry) => lastHashByKey.get(entry.key) !== entry.hash)
}

export function formatAdditionalContext(
	entries: WorkspaceContextDelta[],
): string {
	const payload = JSON.stringify(
		Object.fromEntries(entries.map((e) => [e.key, e.content])),
	)
	return `<AdditionalContext>${payload}</AdditionalContext>`
}
