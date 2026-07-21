import { normalizePath, TFile, TFolder, type App } from 'obsidian'
import { z } from 'zod/mini'
import i18n from '~/i18n'
import { getMasterAgent, type ChatSession } from '~/ai/chat/domain'
import { getWorkspaceContextDeltas } from '~/ai/chat/messages/ui-message'
import { findAgent } from '~/ai/chat/agents/agent-tree'

export const textValue = (field: string) =>
	z.string({
		error: () => i18n.t('chatbox.errors.toolFieldRequired', { field }),
	})

export const booleanValue = (field: string) =>
	z.pipe(
		z.transform((value: unknown) => {
			if (typeof value === 'boolean') {
				return value
			}
			if (typeof value === 'string') {
				const normalized = value.trim().toLowerCase()
				if (normalized === 'true') {
					return true
				}
				if (normalized === 'false') {
					return false
				}
			}
			return value
		}),
		z.boolean(i18n.t('chatbox.errors.toolFieldRequired', { field })),
	)

export const integerValue = (field: string) =>
	z.pipe(
		z.transform((value: unknown) => {
			if (typeof value === 'number') {
				return value
			}
			if (typeof value === 'string') {
				const normalized = value.trim()
				if (normalized !== '') {
					return Number(normalized)
				}
			}
			return value
		}),
		z.int(i18n.t('chatbox.errors.toolFieldRequired', { field })),
	)

interface ReplaceResult {
	content: string
	matchCount: number
}

export function replaceUniqueOccurrence(
	content: string,
	oldText: string,
	newText: string,
) {
	if (oldText === '') {
		if (content !== '') {
			throw new Error(i18n.t('chatbox.errors.editMatchNotUnique'))
		}
		return {
			content: newText,
			matchCount: 1,
		} satisfies ReplaceResult
	}

	let matchIndex = content.indexOf(oldText)
	let matchCount = 0

	while (matchIndex !== -1) {
		matchCount += 1
		if (matchCount > 1) {
			break
		}
		matchIndex = content.indexOf(oldText, matchIndex + oldText.length)
	}

	if (matchCount === 0) {
		throw new Error(i18n.t('chatbox.errors.editMatchNotFound'))
	}
	if (matchCount > 1) {
		throw new Error(i18n.t('chatbox.errors.editMatchNotUnique'))
	}

	return {
		content: content.replace(oldText, newText),
		matchCount,
	} satisfies ReplaceResult
}

export function resolveCurrentNotePath({
	session,
	agentId,
}: {
	session: ChatSession
	agentId: string
}) {
	const agent =
		findAgent(getMasterAgent(session), agentId) ?? getMasterAgent(session)

	for (let index = agent.timeline.length - 1; index >= 0; index -= 1) {
		const activeFile = getWorkspaceContextDeltas(agent.timeline[index]).find(
			(entry) => entry.key === 'activeFile',
		)
		if (activeFile) {
			return typeof activeFile.content === 'string' ? activeFile.content : ''
		}
	}

	return ''
}

export function resolveNotePath(app: App, note: string, sourcePath: string) {
	const normalizedPath = normalizePath(note)
	const direct = app.vault.getAbstractFileByPath(normalizedPath)
	if (direct instanceof TFile) {
		return direct.path
	}
	if (direct instanceof TFolder) {
		throw new Error(i18n.t('chatbox.errors.notFile', { path: note }))
	}

	const resolved = app.metadataCache.getFirstLinkpathDest(note, sourcePath)
	if (resolved instanceof TFile) {
		return resolved.path
	}

	throw new Error(i18n.t('chatbox.errors.fileNotFound', { path: note }))
}
