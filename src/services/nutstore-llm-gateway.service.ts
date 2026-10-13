import type { ModuleScope } from '~/modules/lifecycle'
import { guardIO } from '~/modules/guard-io'
import { LlmGatewayClient } from '@nutstore/sso-js'
import { Notice } from 'obsidian'
import { Subscription, timer } from 'rxjs'
import {
	createModelConfig,
	sanitizeDefaultSelections,
} from '~/ai/catalog/config'
import { obsidianFetch } from '~/ai/transport/obsidian-fetch'
import type {
	AIModelConfig,
	AIModelInput,
	AIModelModality,
	AIProviderConfig,
} from '~/ai/core/types'
import {
	LLM_GATEWAY_CLIENT_ID,
	NUTSTORE_LLM_GATEWAY_PROVIDER_ID,
} from '~/consts'
import { emitNutstoreLlmGatewayAuth } from '~/events/nutstore-llm-gateway-auth'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import { BaseService } from './service.interface'
import type NutstorePlugin from '..'

const TOKEN_REFRESH_SKEW_MS = 60 * 1000
const TOKEN_REFRESH_INTERVAL_MS = 60 * 1000

type NutstoreLlmGatewayModelApi = 'openai-completions'
type NutstoreLlmGatewayThinkingFormat = 'openrouter' | 'openai'

interface NutstoreLlmGatewayModelCost {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
}

interface NutstoreLlmGatewayModelCompat {
	thinkingFormat: NutstoreLlmGatewayThinkingFormat
	supportsReasoningEffort: boolean
}

interface NutstoreLlmGatewayModel {
	id: string
	name: string
	description: string
	api: NutstoreLlmGatewayModelApi
	reasoning: boolean
	input: AIModelModality[]
	cost: NutstoreLlmGatewayModelCost
	contextWindow: number
	maxTokens: number
	compat: NutstoreLlmGatewayModelCompat
}

interface ModelsResponse {
	object: 'list'
	data: NutstoreLlmGatewayModel[]
}

export interface NutstoreLlmGatewayAuthSettings {
	accessToken?: string
	refreshToken?: string
	accessTokenExpiresAt?: number
	refreshTokenExpiresAt?: number
	pendingAuthorization?: NutstoreLlmGatewayPendingAuthorization
}

interface OAuthTokenResponse {
	access_token: string
	refresh_token: string
	expires_in?: number
	refresh_expires_in?: number
}

export interface NutstoreLlmGatewayPendingAuthorization {
	clientId: string
	deviceCode: string
	userCode: string
	verificationUri: string
	verificationUrl: string
	intervalMs: number
	expiresAt: number
}

export interface NutstoreLlmGatewayUsageWindow {
	limit: number
	used: number
	remaining: number
	remaining_percentage: number
	next_reset_at: string | null
}

export interface NutstoreLlmGatewayCreditPackage {
	package_id: string
	source_type: string
	total_credit: number
	used_credit: number
	remaining_credit: number
	remaining_percentage: number
	expires_at: string
	status: string
}

export interface NutstoreLlmGatewayUsage {
	available_credit?: number
	unbilled_requests?: NutstoreLlmGatewayUsageWindow
	credit_usage?: {
		monthly?: NutstoreLlmGatewayCreditPackage
		grant_packages?: NutstoreLlmGatewayCreditPackage[]
		topup_packages?: NutstoreLlmGatewayCreditPackage[]
	}
}

function expiresAtFromNow(seconds: number | undefined) {
	return Date.now() + Math.max(0, seconds || 0) * 1000
}

function isAuthError(status: number) {
	return status === 401 || status === 403
}

function isTokenUsable(expiresAt?: number) {
	return !!expiresAt && expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS
}

function toModelConfig(model: NutstoreLlmGatewayModel): AIModelInput {
	return {
		id: model.id,
		name: model.name,
		attachment: false,
		reasoning: model.reasoning,
		tool_call: true,
		temperature: true,
		knowledge: model.description,
		release_date: '',
		last_updated: '',
		modalities: {
			input: model.input,
			output: ['text'],
		},
		open_weights: false,
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cache_read: model.cost.cacheRead,
			cache_write: model.cost.cacheWrite,
		},
		limit: {
			context: model.contextWindow,
			output: model.maxTokens,
		},
		provider: {
			shape: 'completions',
		},
		experimental: {
			nutstoreLlmGateway: {
				api: model.api,
				compat: model.compat,
			},
		},
	}
}

export default class NutstoreLlmGatewayService extends BaseService {
	private readonly client: LlmGatewayClient
	private refreshSubscription: Subscription | null = null
	private authorizationPollingSubscription: Subscription | null = null

	constructor(
		private plugin: NutstorePlugin,
		private readonly scope: ModuleScope,
	) {
		super()
		this.client = guardIO(
			new LlmGatewayClient({
				fetcher: (input, init) => this.fetch(input, init),
			}),
			scope.check,
		)
	}

	private fetch: typeof fetch = (input, init) => {
		this.scope.check()
		return this.scope
			.wait(obsidianFetch(input, { ...init, signal: this.scope.signal }))
			.then((response) => guardIO(response, this.scope.check))
	}

	isProviderId(providerId?: string) {
		return providerId === NUTSTORE_LLM_GATEWAY_PROVIDER_ID
	}

	isManagedProvider(provider?: Pick<AIProviderConfig, 'id'>) {
		return this.isProviderId(provider?.id)
	}

	isAuthorized() {
		return !!this.settings.accessToken && !!this.settings.refreshToken
	}

	isAuthorizing() {
		return !!this.settings.pendingAuthorization
	}

	getPendingAuthorization() {
		return this.settings.pendingAuthorization
	}

	private emitAuthState() {
		emitNutstoreLlmGatewayAuth({
			status: this.isAuthorizing() ? 'authorizing' : 'idle',
		})
	}

	async startAuthorization() {
		this.scope.check()
		if (this.settings.pendingAuthorization) {
			this.resumeAuthorizationPolling()
			return this.settings.pendingAuthorization
		}

		const clientId = LLM_GATEWAY_CLIENT_ID?.trim()
		if (!clientId) {
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.missingClientId'),
			)
		}

		const deviceAuth = await this.client.createDeviceAuthorization({
			clientId,
		})
		const pendingAuthorization: NutstoreLlmGatewayPendingAuthorization = {
			clientId,
			deviceCode: deviceAuth.device_code,
			userCode: deviceAuth.user_code,
			verificationUri: deviceAuth.verification_uri,
			verificationUrl: this.client.createVerificationUrl({
				verificationUri: deviceAuth.verification_uri,
				userCode: deviceAuth.user_code,
			}),
			intervalMs: deviceAuth.interval * 1000,
			expiresAt: Date.now() + deviceAuth.expires_in * 1000,
		}

		this.settings.pendingAuthorization = pendingAuthorization
		this.emitAuthState()
		await this.plugin.settingsService.saveSettings()
		this.resumeAuthorizationPolling()
		return pendingAuthorization
	}

	async openPendingAuthorizationPage() {
		this.scope.check()
		const pending = this.settings.pendingAuthorization
		if (!pending) {
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.authorizationRequired'),
			)
		}

		const anchor = createEl('a')
		anchor.href = pending.verificationUrl
		anchor.target = '_blank'
		document.body.appendChild(anchor)
		anchor.click()
		document.body.removeChild(anchor)
	}

	async refreshModels(options: { removeOnAuthError?: boolean } = {}) {
		this.scope.check()
		const token = await this.ensureAccessToken(options)
		if (!token) {
			return false
		}

		const endpoints = this.client.getLlmGatewayEndpoints()
		const response = await this.fetch(endpoints.models, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
		})
		if (!response.ok) {
			if (isAuthError(response.status) && options.removeOnAuthError) {
				this.clearProviderAndAuth()
			}
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.modelsFailed', {
					status: response.status,
				}),
			)
		}

		const payload = (await response.json()) as ModelsResponse
		const models = Object.fromEntries(
			payload.data
				.map((model) => ({
					...model,
					id: model.id.trim(),
					name: model.name.trim(),
				}))
				.filter((model) => !!model.id)
				.map((model) => [model.id, createModelConfig(toModelConfig(model))]),
		)

		if (Object.keys(models).length === 0) {
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.emptyModels'),
			)
		}

		this.plugin.settings.ai.providers = {
			...this.plugin.settings.ai.providers,
			[NUTSTORE_LLM_GATEWAY_PROVIDER_ID]: this.createProvider(token, models),
		}
		this.plugin.settings.ai.defaultModel = sanitizeDefaultSelections(
			this.plugin.settings.ai.providers,
			this.plugin.settings.ai.defaultModel,
		)
		return true
	}

	async getUsage(): Promise<NutstoreLlmGatewayUsage> {
		this.scope.check()
		const hadAuthorization = this.isAuthorized()
		const previousAccessToken = this.settings.accessToken
		let token: string | undefined
		try {
			token = await this.ensureAccessToken({ removeOnAuthError: true })
		} catch (error) {
			this.scope.check()
			if (hadAuthorization && !this.isAuthorized()) {
				await this.plugin.settingsService.saveSettings()
			}
			throw error
		}

		if (!token) {
			if (hadAuthorization) {
				await this.plugin.settingsService.saveSettings()
			}
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.authorizationRequired'),
			)
		}

		if (token !== previousAccessToken) {
			this.updateProviderApiKey(token)
			await this.plugin.settingsService.saveSettings()
		}

		const response = await this.fetch(
			this.client.getLlmGatewayEndpoints().rateLimits,
			{
				method: 'GET',
				headers: { Authorization: `Bearer ${token}` },
				cache: 'no-store',
			},
		)
		if (!response.ok) {
			if (isAuthError(response.status)) {
				this.clearProviderAndAuth()
				await this.plugin.settingsService.saveSettings()
			}
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.usageFailed', {
					status: response.status,
				}),
			)
		}

		return (await response.json()) as NutstoreLlmGatewayUsage
	}

	async ensureProviderReady(provider?: AIProviderConfig) {
		this.scope.check()
		if (!this.isProviderId(provider?.id)) {
			return
		}
		const previousAccessToken = this.settings.accessToken
		const token = await this.ensureAccessToken({ removeOnAuthError: true })
		if (!token) {
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.authorizationRequired'),
			)
		}
		this.updateProviderApiKey(token)
		if (provider) {
			provider.apiKey = token
		}
		if (token !== previousAccessToken) {
			await this.plugin.settingsService.saveSettings()
		}
	}

	async initializeProviderFromStoredAuth() {
		this.scope.check()
		if (this.settings.pendingAuthorization) {
			if (this.settings.pendingAuthorization.expiresAt <= Date.now()) {
				this.settings.pendingAuthorization = undefined
				await this.plugin.settingsService.saveSettings()
			} else {
				this.emitAuthState()
				this.resumeAuthorizationPolling()
			}
		}

		if (!this.isAuthorized()) {
			this.stopTokenRefreshTimer()
			return
		}
		try {
			const refreshed = await this.refreshModels({ removeOnAuthError: true })
			this.startTokenRefreshTimer()
			if (refreshed) {
				await this.plugin.settingsService.saveSettings()
			}
		} catch (error) {
			this.scope.check()
			this.noticeError(error)
			await this.plugin.settingsService.saveSettings()
			if (this.isAuthorized()) {
				this.startTokenRefreshTimer()
			} else {
				this.stopTokenRefreshTimer()
			}
		}
	}

	async disconnect() {
		this.scope.check()
		await this.cancelPendingAuthorization()
		this.clearProviderAndAuth()
		await this.plugin.settingsService.saveSettings()
		new Notice(i18n.t('settings.ai.nutstoreLlmGateway.disconnected'))
	}

	override onunload() {
		this.stopAuthorizationPolling()
		this.stopTokenRefreshTimer()
	}

	private async ensureAccessToken(options: { removeOnAuthError?: boolean }) {
		this.scope.check()
		if (isTokenUsable(this.settings.accessTokenExpiresAt)) {
			return this.settings.accessToken
		}
		if (
			!this.settings.refreshToken ||
			!isTokenUsable(this.settings.refreshTokenExpiresAt)
		) {
			if (options.removeOnAuthError) {
				this.clearProviderAndAuth()
			}
			return undefined
		}

		try {
			const token = await this.client.refreshToken({
				refreshToken: this.settings.refreshToken,
			})
			this.applyToken(token)
			return token.access_token
		} catch (error) {
			this.scope.check()
			if (options.removeOnAuthError) {
				this.clearProviderAndAuth()
			}
			throw error
		}
	}

	private applyToken(token: OAuthTokenResponse) {
		this.scope.check()
		this.settings.accessToken = token.access_token
		this.settings.refreshToken = token.refresh_token
		this.settings.accessTokenExpiresAt = expiresAtFromNow(token.expires_in)
		this.settings.refreshTokenExpiresAt = expiresAtFromNow(
			token.refresh_expires_in,
		)
	}

	private createProvider(
		accessToken: string,
		models: Record<string, AIModelConfig>,
	): AIProviderConfig {
		const endpoints = this.client.getLlmGatewayEndpoints()
		return {
			id: NUTSTORE_LLM_GATEWAY_PROVIDER_ID,
			env: [],
			npm: '@ai-sdk/openai-compatible',
			api: endpoints.openaiCompatibleBaseUrl,
			name: i18n.t('settings.ai.nutstoreLlmGateway.providerName'),
			doc: '',
			apiKey: accessToken,
			allowBrowserCors: true,
			models,
		}
	}

	private clearProviderAndAuth() {
		this.scope.check()
		this.settings.accessToken = undefined
		this.settings.refreshToken = undefined
		this.settings.accessTokenExpiresAt = undefined
		this.settings.refreshTokenExpiresAt = undefined
		this.settings.pendingAuthorization = undefined
		this.disableProviderToken()
		this.stopAuthorizationPolling()
		this.stopTokenRefreshTimer()
		this.emitAuthState()
	}

	private disableProviderToken() {
		this.scope.check()
		const provider =
			this.plugin.settings.ai.providers[NUTSTORE_LLM_GATEWAY_PROVIDER_ID]
		if (provider) {
			provider.apiKey = ''
		}
	}

	private startTokenRefreshTimer() {
		if (this.scope.signal.aborted) return
		if (this.refreshSubscription) {
			return
		}
		this.refreshSubscription = timer(
			TOKEN_REFRESH_INTERVAL_MS,
			TOKEN_REFRESH_INTERVAL_MS,
		).subscribe(() => {
			void this.scope.background(
				() => this.refreshAccessTokenIfNeeded(),
				(error) => this.noticeError(error),
			)
		})
	}

	private stopTokenRefreshTimer() {
		if (!this.refreshSubscription) {
			return
		}
		this.refreshSubscription.unsubscribe()
		this.refreshSubscription = null
	}

	private async refreshAccessTokenIfNeeded() {
		if (this.scope.signal.aborted) return
		if (
			!this.isAuthorized() ||
			isTokenUsable(this.settings.accessTokenExpiresAt)
		) {
			return
		}
		try {
			const token = await this.ensureAccessToken({ removeOnAuthError: true })
			if (!token) {
				await this.plugin.settingsService.saveSettings()
				return
			}
			this.updateProviderApiKey(token)
			await this.plugin.settingsService.saveSettings()
		} catch (error) {
			this.scope.check()
			this.noticeError(error)
			await this.plugin.settingsService.saveSettings()
		}
	}

	private resumeAuthorizationPolling() {
		if (this.scope.signal.aborted) return
		if (this.authorizationPollingSubscription) {
			return
		}

		const pending = this.settings.pendingAuthorization
		if (!pending) {
			this.emitAuthState()
			return
		}

		this.emitAuthState()
		this.scheduleDeviceTokenPoll(pending, pending.intervalMs)
	}

	private scheduleDeviceTokenPoll(
		pending: NutstoreLlmGatewayPendingAuthorization,
		pollIntervalMs: number,
	) {
		if (this.scope.signal.aborted) return
		this.authorizationPollingSubscription?.unsubscribe()
		this.authorizationPollingSubscription = timer(pollIntervalMs).subscribe(
			() => {
				void this.scope.background(
					() => this.pollDeviceTokenOnce(pending, pollIntervalMs),
					(error) => this.noticeError(error),
				)
			},
		)
	}

	private stopAuthorizationPolling() {
		if (!this.authorizationPollingSubscription) {
			return
		}
		this.authorizationPollingSubscription.unsubscribe()
		this.authorizationPollingSubscription = null
	}

	private async pollDeviceTokenOnce(
		pending: NutstoreLlmGatewayPendingAuthorization,
		pollIntervalMs: number,
	) {
		try {
			if (Date.now() >= pending.expiresAt) {
				throw new Error(
					i18n.t('settings.ai.nutstoreLlmGateway.errors.authorizationExpired'),
				)
			}

			const currentPending = this.settings.pendingAuthorization
			if (!currentPending || currentPending.deviceCode !== pending.deviceCode) {
				this.stopAuthorizationPolling()
				this.emitAuthState()
				return
			}

			const result = await this.client.pollDeviceToken({
				deviceCode: pending.deviceCode,
				userCode: pending.userCode,
			})

			if (!result.ok) {
				if (result.error.code === 'authorization_pending') {
					this.scheduleDeviceTokenPoll(pending, pollIntervalMs)
					return
				}
				if (result.error.code === 'slow_down') {
					this.scheduleDeviceTokenPoll(
						pending,
						pollIntervalMs + pending.intervalMs,
					)
					return
				}
				throw new Error(
					i18n.t('settings.ai.nutstoreLlmGateway.errors.authorizationFailed', {
						code: result.error.code,
						message: result.error.message,
					}),
				)
			}

			this.stopAuthorizationPolling()
			await this.finishAuthorization(result.data)
			this.emitAuthState()
		} catch (error) {
			this.scope.check()
			this.stopAuthorizationPolling()
			this.settings.pendingAuthorization = undefined
			await this.plugin.settingsService.saveSettings()
			this.noticeError(error)
			this.emitAuthState()
		}
	}

	private async finishAuthorization(token: OAuthTokenResponse) {
		this.scope.check()
		this.applyToken(token)
		this.settings.pendingAuthorization = undefined
		try {
			await this.refreshModels({ removeOnAuthError: true })
			this.startTokenRefreshTimer()
			new Notice(i18n.t('settings.ai.nutstoreLlmGateway.authorized'))
		} finally {
			await this.plugin.settingsService.saveSettings()
		}
	}

	private async cancelPendingAuthorization() {
		const pending = this.settings.pendingAuthorization
		if (!pending) {
			return
		}

		try {
			await this.client.cancelDeviceAuthorization({
				deviceCode: pending.deviceCode,
			})
		} catch (error) {
			this.scope.check()
			logger.error(error)
		}
	}

	private updateProviderApiKey(apiKey: string) {
		this.scope.check()
		const provider =
			this.plugin.settings.ai.providers[NUTSTORE_LLM_GATEWAY_PROVIDER_ID]
		if (provider) {
			provider.apiKey = apiKey
		}
	}

	private noticeError(error: unknown) {
		if (this.scope.signal.aborted) return
		logger.error(error)
		new Notice(
			error instanceof Error ? error.message : i18n.t('settings.login.failure'),
			10000,
		)
	}

	private get settings() {
		this.plugin.settings.ai.nutstoreLlmGateway ??= {}
		return this.plugin.settings.ai.nutstoreLlmGateway
	}
}
