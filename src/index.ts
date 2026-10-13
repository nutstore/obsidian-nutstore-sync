import 'blob-polyfill'

import './polyfill'
import './webdav-patch'

import './assets/styles/global.css'

import { toBase64 } from 'js-base64'
import { normalizePath, Plugin } from 'obsidian'
import { registerChatboxAiIcon } from './assets/icons/obsidian-nutstore-ai-icon'
import i18n from './i18n'
import I18nService from './services/i18n.service'
import LoggerService from './services/logger.service'
import ProtocolService from './services/protocol.service'
import SettingsService from './services/settings.service'
import {
	NutstoreLocalSettings,
	NutstoreSettings,
	NutstoreSettingTab,
} from './settings'
import { decryptOAuthResponse } from './utils/decrypt-ticket-response'
import { stdRemotePath } from './utils/std-remote-path'
import { SyncModule } from './modules/sync-module'
import { AiModule } from './modules/ai-module'
import { ModuleState } from './modules/lifecycle'
import logger from './utils/logger'

export default class NutstorePlugin extends Plugin {
	declare public settings: NutstoreSettings

	public isSyncing: boolean = false
	public localSettings!: NutstoreLocalSettings
	public settingTab!: NutstoreSettingTab

	public readonly settingsService = new SettingsService(this)
	public readonly i18nService = new I18nService(this)
	public readonly loggerService = new LoggerService(this)
	public readonly protocolService = new ProtocolService(this)
	public readonly sync = new SyncModule(this)
	public readonly ai = new AiModule(this)
	private loaded = false

	async onload() {
		this.loggerService.onload()
		await this.settingsService.onload()
		await this.i18nService.onload()
		registerChatboxAiIcon()
		this.settingTab = new NutstoreSettingTab(this.app, this)
		this.loaded = true
		await this.applySettings()
		this.ai.registerViews()
		this.protocolService.onload()
		this.addSettingTab(this.settingTab)
	}

	/** Every settings writer reconciles the same two module lifetimes. */
	async applySettings() {
		if (!this.loaded) return
		await Promise.all([
			this.sync.lifecycle.update(
				this.localSettings.modules.sync === ModuleState.Enabled,
			),
			this.ai.lifecycle.update(
				this.localSettings.modules.ai === ModuleState.Enabled,
			),
		])
		await this.i18nService.update()
		if (this.sync.lifecycle.active) await this.sync.scheduled.updateInterval()
		if (this.ai.lifecycle.active) {
			this.ai.models.initializeFromLocalSettings()
			await this.ai.chat.handleSettingsChanged()
			await this.ai.conflicts.refresh()
		}
	}

	onunload() {
		this.loaded = false
		this.settingTab?.unload()
		this.settingsService.onunload()
		void Promise.all([
			this.sync.lifecycle.update(false),
			this.ai.lifecycle.update(false),
		]).catch((error: unknown) => logger.error('Module shutdown failed', error))
	}

	toggleSyncUI(isSyncing: boolean) {
		this.isSyncing = isSyncing
		this.sync.ribbon.update()
	}

	async getDecryptedOAuthInfo() {
		return decryptOAuthResponse(this.settings.oauthResponseText)
	}

	async getToken() {
		let token
		if (this.settings.loginMode === 'sso') {
			let oauth
			try {
				oauth = await this.getDecryptedOAuthInfo()
			} catch {
				throw new Error(i18n.t('sync.error.ssoTokenInvalid'))
			}
			token = `${oauth.username}:${oauth.access_token}`
		} else {
			token = `${this.settings.account}:${this.settings.credential}`
		}
		return toBase64(token)
	}

	async getRemoteAccountId() {
		if (this.settings.loginMode === 'sso') {
			return (await this.getDecryptedOAuthInfo()).username.trim()
		}
		return this.settings.account.trim()
	}

	/**
	 * 检查账号配置是否完整
	 * @returns true 表示配置完整，false 表示未配置或配置不完整
	 */
	isAccountConfigured(): boolean {
		if (this.settings.loginMode === 'sso') {
			// SSO 模式：检查是否有 OAuth 响应数据
			return (
				!!this.settings.oauthResponseText &&
				this.settings.oauthResponseText.trim() !== ''
			)
		} else {
			// 手动模式：检查账号和凭证是否都已填写
			return (
				!!this.settings.account &&
				this.settings.account.trim() !== '' &&
				!!this.settings.credential &&
				this.settings.credential.trim() !== ''
			)
		}
	}

	get remoteBaseDir() {
		let remoteDir = normalizePath(this.settings.remoteDir.trim())
		if (remoteDir === '' || remoteDir === '/') {
			remoteDir = this.app.vault.getName()
		}
		return stdRemotePath(remoteDir)
	}
}
