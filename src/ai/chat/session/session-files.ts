import { normalizePath, Vault } from 'obsidian'
import type { PersistedChatSession } from '~/ai/chat/session/session-persistence'
import {
	readLocalText,
	removeLocalPath,
	writeLocalTextAtomic,
} from '~/utils/local-vault-io'

/**
 * Chat sessions are persisted as individual JSON files inside the vault (next
 * to the other plugin-managed agent config), so they are grep-able, cross-device
 * syncable via the existing sync module, and resilient to meta/index loss.
 *
 * Layout:
 *   .agents/nutstore-sync/
 *     chat-meta.json          # lightweight index: order + active + cached titles
 *     sessions/<id>.json      # one whole ChatSession snapshot per file
 *
 * The title is embedded in EACH session file as well as cached in chat-meta.json
 * so a deleted or corrupted meta file never destroys the session titles.
 */
export const CHAT_ROOT_DIR = '.agents/nutstore-sync'
export const CHAT_SESSIONS_DIR = `${CHAT_ROOT_DIR}/sessions`
export const CHAT_META_FILENAME = 'chat-meta.json'

export interface ChatSessionFilePayload {
	/** Whole session snapshot (blobs already base64url-encoded). */
	session: PersistedChatSession
	/** Human title stored alongside the snapshot; source of truth per file. */
	title?: string
}

export interface ChatMetaSessionInfo {
	title: string
	createdAt: number
	updatedAt: number
}

export interface ChatMetaFile {
	activeSessionId?: string
	orderedSessionIds: string[]
	/**
	 * Cached per-session index data so the list renders without loading files.
	 * Backed up by the embedded title inside each session file, so a lost or
	 * corrupted meta file can always be rebuilt from the session files.
	 */
	sessions: Record<string, ChatMetaSessionInfo>
}

export class SessionFileCorruptError extends Error {
	constructor(public readonly filePath: string) {
		super(`Corrupted chat session file: ${filePath}`)
		this.name = 'SessionFileCorruptError'
	}
}

export function getChatSessionPath(id: string) {
	return normalizePath(`${CHAT_SESSIONS_DIR}/${id}.json`)
}

export function getChatMetaPath() {
	return normalizePath(`${CHAT_ROOT_DIR}/${CHAT_META_FILENAME}`)
}

export function isChatMetaFile(value: unknown): value is ChatMetaFile {
	return (
		!!value &&
		typeof value === 'object' &&
		Array.isArray((value as ChatMetaFile).orderedSessionIds) &&
		typeof (value as ChatMetaFile).sessions === 'object' &&
		(value as ChatMetaFile).sessions !== null
	)
}

function stringifyJsonFile(value: unknown) {
	return `${JSON.stringify(value, null, 2)}\n`
}

export class SessionsFileBackend {
	constructor(private vault: Vault) {}

	private get adapter() {
		return this.vault.adapter
	}

	private async ensureSessionsDir() {
		try {
			await this.adapter.mkdir(CHAT_SESSIONS_DIR)
		} catch {
			/* directory already exists */
		}
	}

	async writeSessionFile(id: string, payload: ChatSessionFilePayload) {
		await this.ensureSessionsDir()
		await writeLocalTextAtomic(
			this.vault,
			getChatSessionPath(id),
			stringifyJsonFile(payload),
		)
	}

	async readSessionFile(id: string): Promise<ChatSessionFilePayload> {
		const filePath = getChatSessionPath(id)
		let content: string
		try {
			content = await readLocalText(this.vault, filePath)
		} catch {
			const exists = await this.adapter.exists(filePath)
			if (!exists) {
				throw new Error(`Session file not found: ${filePath}`)
			}
			throw new SessionFileCorruptError(filePath)
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(content)
		} catch {
			throw new SessionFileCorruptError(filePath)
		}
		if (!parsed || typeof parsed !== 'object') {
			throw new SessionFileCorruptError(filePath)
		}
		const record = parsed as { session?: unknown; title?: unknown }
		if (!record.session || typeof record.session !== 'object') {
			throw new SessionFileCorruptError(filePath)
		}
		return {
			session: record.session as PersistedChatSession,
			title: typeof record.title === 'string' ? record.title : undefined,
		}
	}

	async deleteSessionFile(id: string) {
		await removeLocalPath(this.vault, getChatSessionPath(id))
	}

	async listSessionIds(): Promise<string[]> {
		let files: string[]
		try {
			files = (await this.adapter.list(CHAT_SESSIONS_DIR)).files
		} catch {
			return []
		}
		return files
			.map((path) => normalizePath(path).split('/').pop() ?? '')
			.filter((name) => name.endsWith('.json'))
			.map((name) => name.slice(0, -'.json'.length))
			.filter((id) => id.length > 0)
	}

	async hasAnySessionFiles(): Promise<boolean> {
		return (await this.listSessionIds()).length > 0
	}

	async writeMetaFile(meta: ChatMetaFile) {
		await this.ensureSessionsDir()
		await writeLocalTextAtomic(
			this.vault,
			getChatMetaPath(),
			stringifyJsonFile(meta),
		)
	}

	async readMetaFile(): Promise<ChatMetaFile | null> {
		const filePath = getChatMetaPath()
		let content: string
		try {
			content = await readLocalText(this.vault, filePath)
		} catch {
			return null
		}
		try {
			const parsed = JSON.parse(content)
			return isChatMetaFile(parsed) ? parsed : null
		} catch {
			return null
		}
	}
}
