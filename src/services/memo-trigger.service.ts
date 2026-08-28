import { Notice, TAbstractFile, TFile } from 'obsidian'
import type NutstorePlugin from '..'
import i18n from '~/i18n'
import { memoTriggerKV } from '~/storage/kv'
import logger from '~/utils/logger'
import { BaseService } from './service.interface'

export const MEMO_TRIGGER_DEFAULT_MESSAGE = '总结备忘录'

const MEMO_TRIGGER_KV_KEY = 'memo_trigger'

export interface MemoTriggerState {
	counted: string[]
}

/**
 * Whether a vault file path should count toward the memo auto-trigger.
 * Memos are plain `.md` notes; the config dirs (`.obsidian`, `.agents`) and
 * the vault welcome note are excluded.
 */
export function isMemoCandidatePath(path: string): boolean {
	const parts = path.split('/')
	if (parts.some((part) => part === '.obsidian' || part === '.agents')) {
		return false
	}
	if (!path.endsWith('.md')) {
		return false
	}
	const name = parts[parts.length - 1]
	if (name === '欢迎.md' || name === 'welcome.md') {
		return false
	}
	return true
}

/**
 * Watches vault note creation and, once enough new memos have accumulated,
 * automatically asks the AI agent to process them (e.g. via the
 * `memo-to-todo` skill that summarizes memos into Todoist tasks).
 *
 * This is an event-driven trigger — it fires while Obsidian is running and
 * the plugin is loaded. The count survives restarts via KV storage.
 */
export default class MemoTriggerService extends BaseService {
	private counted = new Set<string>()

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override async onload() {
		try {
			const stored = await memoTriggerKV.get(MEMO_TRIGGER_KV_KEY)
			if (stored?.counted) {
				this.counted = new Set(stored.counted)
			}
		} catch (error) {
			logger.warn('Failed to restore memo trigger state', error)
		}

		this.plugin.registerEvent(
			this.plugin.app.vault.on('create', (file) => {
				void this.handleCreatedFile(file)
			}),
		)
	}

	private async handleCreatedFile(file: TAbstractFile) {
		const memoTrigger = this.plugin.settings.ai.memoTrigger
		if (!memoTrigger?.enabled) {
			return
		}
		if (!(file instanceof TFile) || !isMemoCandidatePath(file.path)) {
			return
		}

		this.counted.add(file.path)
		await this.persist()

		const threshold = memoTrigger.threshold > 0 ? memoTrigger.threshold : 10
		if (this.counted.size >= threshold) {
			await this.trigger(memoTrigger.message || MEMO_TRIGGER_DEFAULT_MESSAGE)
		}
	}

	private async trigger(message: string) {
		this.counted.clear()
		await this.persist()

		try {
			const accepted = await this.plugin.chatService.sendMessage(message)
			if (accepted) {
				new Notice(i18n.t('memoTrigger.triggered'))
			} else {
				new Notice(i18n.t('memoTrigger.triggerRejected'))
			}
		} catch (error) {
			logger.error('Memo auto-trigger failed', error)
			new Notice(i18n.t('memoTrigger.triggerError'))
		}
	}

	private async persist() {
		try {
			await memoTriggerKV.set(MEMO_TRIGGER_KV_KEY, {
				counted: [...this.counted],
			})
		} catch (error) {
			logger.warn('Failed to persist memo trigger state', error)
		}
	}
}
