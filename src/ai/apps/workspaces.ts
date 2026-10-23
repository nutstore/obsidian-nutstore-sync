import { VaultFileSystemManager } from '~/ai/tools/vault-filesystem'
import { createAppFSDispatcher } from './capabilities/fs'
import type { App } from 'obsidian'
import type { ChatSession } from '~/ai/chat/domain'
import type { ModuleScope } from '~/modules/lifecycle'
import { guardAppIO } from '~/modules/guard-io'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import { isAbortError, throwIfAborted } from '~/utils/abort'
import { raceWithAbort } from '~/utils/abortable'
import {
	existsLocalPath,
	readLocalBinary,
	readLocalText,
} from '~/utils/local-vault-io'
import logger from '~/utils/logger'
import {
	APP_ENTRY_FILE,
	APP_LOG_FILE,
	APP_ROOT_DIR,
	appDirectoryPath,
} from './paths'
import { changeKV, type AppKV, type KVChange } from './capabilities/kv'
import { appError } from './error'
import { validateAppIcon } from './icon'
import { AppLogStore } from './logs'
import { AppRuntime, type RuntimeHost } from './runtime'
import { assembleAppContent, type AppContent } from './source'
import { AppStore, type SavedApp } from './store'
import type { AppAIHost } from './ai/contract'

export interface LoadedApp extends SavedApp {
	content: AppContent
}

export interface AppOpenResult {
	appId: string
	title: string
}

export type AppOpenFn = (appId: string) => Promise<AppOpenResult>

export interface AppWorkspaceBinding {
	check(): void
	selectedAppId(): string | undefined
	access(appId: string, pending?: boolean): Promise<void>
}

/** Apps are plain files; this layer owns assembly, validation and runtime lifetime. */
export class AppWorkspaces {
	readonly store: AppStore
	readonly logs: AppLogStore

	constructor(
		private readonly app: App,
		private readonly scope: ModuleScope,
		private readonly ai?: AppAIHost,
	) {
		this.logs = new AppLogStore(app)
		this.store = new AppStore(guardAppIO(app, scope.check, scope.track))
	}

	async create(id: string, title: string) {
		this.scope.check()
		return this.store.create(id, title)
	}

	/** Read the real App files and inline every relative source reference. */
	async load(appId: string): Promise<LoadedApp> {
		this.scope.check()
		const saved = await this.store.read(appId)
		this.scope.check()
		// The icon is host-rendered SVG; reject an invalid manifest at mount time.
		this.validateIcon(saved.manifest.iconSvg)
		const content = await this.assemble(appId)
		this.scope.check()
		return { ...saved, content }
	}

	private async assemble(appId: string): Promise<AppContent> {
		const directory = appDirectoryPath(appId)
		const entryPath = `${directory}/${APP_ENTRY_FILE}`
		const html = (await existsLocalPath(this.app.vault, entryPath))
			? await readLocalText(this.app.vault, entryPath)
			: ''
		return assembleAppContent({
			html,
			reader: {
				readText: (path) =>
					readLocalText(this.app.vault, `${directory}/${path}`),
				readBinary: (path) =>
					readLocalBinary(this.app.vault, `${directory}/${path}`),
			},
		})
	}

	/**
	 * Boot the assembled App in a throwaway sandbox before the visible view
	 * swaps runtimes. Candidate KV writes land in a disposable clone, so failing
	 * startup can never modify App data.
	 */
	async validate(appId: string, signal?: AbortSignal): Promise<LoadedApp> {
		const check = () => {
			this.scope.check()
			throwIfAborted(signal)
		}
		check()
		const loaded = await this.load(appId)
		check()
		let disposable: AppKV = structuredClone(await this.store.readKV(appId))
		check()
		const doc = this.app.workspace.containerEl.ownerDocument
		const container = doc.win.createDiv()
		container.className = 'ns-app-candidate'
		container.setAttribute('aria-hidden', 'true')
		doc.body.appendChild(container)
		let runtime: AppRuntime | undefined
		try {
			runtime = new AppRuntime(container, loaded.content, {
				fs: createAppFSDispatcher(
					() =>
						new VaultFileSystemManager(
							guardAppIO(this.app, check, this.scope.track),
						).create({ readonlyApps: true }),
					check,
					true,
				),
				readKV: async () => disposable,
				transact: async (changes) => {
					disposable = changeKV(disposable, changes)
				},
				log: (event) => this.logs.append(appId, event),
				error: () => {},
			})
			check()
			try {
				await this.scope.wait(
					signal ? raceWithAbort(runtime.ready, signal) : runtime.ready,
				)
			} catch (error) {
				if (isAbortError(error)) throw error
				throw new Error(
					`${appError(error)}\n[App workspace] Runtime logs: ${APP_ROOT_DIR}/${appId}/${APP_LOG_FILE}`,
					{ cause: error },
				)
			}
			check()
			return loaded
		} finally {
			runtime?.destroy()
			container.remove()
			await this.logs.flush(appId)
		}
	}

	/** Host bridge for one mounted runtime; runtime lifetime replaces revision identity. */
	createRuntimeHost(
		appId: string,
		checkRuntime: () => void = () => {},
	): RuntimeHost {
		const scope = this.scope
		const apps = this.store
		const check = () => {
			scope.check()
			checkRuntime()
		}
		const permissionGuard: PermissionGuard = async (request) => {
			check()
			const { createPermissionGuard } =
				await import('~/ai/tools/permission-guard')
			check()
			await createPermissionGuard(this.app, undefined, {
				sessionTitle: appId,
				signal: scope.signal,
			})(request)
			check()
		}
		const fs = createAppFSDispatcher(
			() =>
				new VaultFileSystemManager(
					guardAppIO(this.app, check, scope.track),
				).create({
					readonlyApps: true,
					permissionGuard,
				}),
			check,
			false,
		)
		return {
			fs,
			ai: this.ai
				? async (request, execution) => {
						check()
						return this.ai!(request, execution)
					}
				: undefined,
			readKV: async () => {
				scope.check()
				return apps.readKV(appId)
			},
			transact: async (changes: KVChange[]) => {
				scope.check()
				await apps.transact(appId, changes)
			},
			log: (event) => {
				this.logs.append(appId, event)
			},
			error: (message) => logger.error(message),
		}
	}

	async setPinned(appId: string, pinned: boolean) {
		this.scope.check()
		await this.store.setPinned(appId, pinned)
	}

	async remove(appId: string) {
		this.scope.check()
		await this.store.remove(appId)
	}

	validateIcon(iconSvg: string) {
		return validateAppIcon(
			iconSvg,
			this.app.workspace.containerEl.ownerDocument,
		)
	}

	/** App access updates the chat selection; a new App is selected on first edit. */
	createBinding(
		session: ChatSession,
		persist: () => Promise<void>,
		signal?: AbortSignal,
	): AppWorkspaceBinding {
		const check = () => {
			this.scope.check()
			throwIfAborted(signal)
		}
		const bind = async (id: string) => {
			check()
			await this.store.read(id)
			check()
			const previous = session.appId
			session.appId = id
			try {
				await persist()
			} catch (error) {
				session.appId = previous
				throw error
			}
		}
		let bindingQueue: Promise<unknown> = Promise.resolve()
		const serializeBinding = <T>(operation: () => Promise<T>) => {
			const pending = bindingQueue.catch(() => {}).then(operation)
			bindingQueue = pending
			return pending
		}
		return {
			check,
			selectedAppId: () => session.appId,
			access: (appId: string, pending = false) =>
				serializeBinding(async () => {
					check()
					if (!pending && session.appId !== appId) await bind(appId)
				}),
		}
	}
}
