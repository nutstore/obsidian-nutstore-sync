import type NutstorePlugin from '~/index'
import { createSelectedTextContextItem } from '~/ai/chat/context/user-context'
import { CHATBOX_AI_ICON_ID } from '~/assets/icons/obsidian-nutstore-ai-icon'
import ChatService from '~/services/chat.service'
import { AppWorkspaces } from '~/ai/apps/workspaces'
import { createAppAIHost } from '~/ai/apps/ai/host'
import AppView, { APP_VIEW_TYPE } from '~/views/app.view'
import type { AppStore } from '~/ai/apps/store'
import { appIconContent, appIconId, validateAppIcon } from '~/ai/apps/icon'
import AppRibbonManager from '~/components/AppRibbonManager'
import { addIcon } from 'obsidian'
import { createScopedRibbonIcon } from '~/utils/scoped-ribbon-icon'
import McpService from '~/services/mcp.service'
import MemoryService from '~/services/memory.service'
import ModelsPresetService from '~/services/models-preset.service'
import NutstoreLlmGatewayService from '~/services/nutstore-llm-gateway.service'
import AIConflictResolverService from '~/services/ai-conflict-resolver.service'
import ChatboxView, { CHATBOX_VIEW_TYPE } from '~/views/chatbox.view'
import {
	MemoryEditorView,
	MEMORY_EDITOR_VIEW_TYPE,
} from '~/views/memory-editor.view'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import { ChatboxLocation } from '~/settings'
import { ModuleLifecycle, type ModuleScope } from './lifecycle'

/** All AI entry points and background resources belong to this lifetime. */
export class AiModule {
	chat!: ChatService
	workspaces!: AppWorkspaces
	apps!: AppStore
	mcp!: McpService
	gateway!: NutstoreLlmGatewayService
	memory!: MemoryService
	readonly models: ModelsPresetService
	readonly conflicts: AIConflictResolverService
	readonly lifecycle = new ModuleLifecycle(
		(scope) => this.start(scope),
		() => this.stop(),
	)

	constructor(private readonly plugin: NutstorePlugin) {
		this.models = new ModelsPresetService(plugin)
		this.conflicts = new AIConflictResolverService(plugin)
	}

	/** Host view factories live once; onOpen also gates restored workspace leaves. */
	registerViews() {
		this.plugin.registerView(
			APP_VIEW_TYPE,
			(leaf) => new AppView(leaf, this.plugin),
		)
		this.plugin.registerView(
			CHATBOX_VIEW_TYPE,
			(leaf) => new ChatboxView(leaf, this.plugin),
		)
		this.plugin.registerView(
			MEMORY_EDITOR_VIEW_TYPE,
			(leaf) => new MemoryEditorView(leaf, this.memory),
		)
	}

	private start(scope: ModuleScope) {
		this.memory = new MemoryService(this.plugin, scope)
		this.mcp = new McpService(this.plugin, scope)
		this.gateway = new NutstoreLlmGatewayService(this.plugin, scope)
		this.workspaces = new AppWorkspaces(
			this.plugin.app,
			scope,
			createAppAIHost(() => this.plugin.settings.ai, scope),
		)
		this.apps = this.workspaces.store
		this.chat = new ChatService(this.plugin, scope)
		new AppRibbonManager(this.plugin, scope, this.apps)
		this.models.initializeFromLocalSettings()
		this.conflicts.onload()
		scope.register(() => this.conflicts.onunload())
		const icon = createScopedRibbonIcon(
			this.plugin,
			CHATBOX_AI_ICON_ID,
			i18n.t('chatbox.openCommand'),
			() => {
				if (!scope.signal.aborted) void this.openChatbox()
			},
		)
		scope.register(icon.dispose)
		for (const command of [
			{
				id: 'open-chatbox',
				name: i18n.t('chatbox.openCommand'),
				icon: CHATBOX_AI_ICON_ID,
				run: () => this.openChatbox(),
			},
			{
				id: 'open-memory-note',
				name: i18n.t('memory.openCommand'),
				icon: 'brain',
				run: () => this.memory.openNote(),
			},
		]) {
			this.plugin.addCommand({
				...command,
				checkCallback: (checking) => {
					if (scope.signal.aborted) return false
					if (!checking)
						void scope.background(command.run, (error) => logger.error(error))
					return true
				},
			})
			scope.register(() => this.plugin.removeCommand(command.id))
		}
		const workspace = this.plugin.app.workspace
		const menuEvent = workspace.on('editor-menu', (menu, editor, view) => {
			if (!editor.somethingSelected() || scope.signal.aborted) return
			menu.addItem((item) => {
				item
					.setTitle(
						i18n.language.startsWith('zh') ? '坚果云同步' : 'Nutstore Sync',
					)
					.setIcon('cloud')
				item.setSubmenu()
				item.submenu?.addItem((subItem) => {
					subItem
						.setTitle(i18n.t('chatbox.addToContext'))
						.setIcon('message-square-plus')
						.onClick(() => {
							if (scope.signal.aborted) return
							const selection = editor.listSelections()[0]
							const file = (view as { file?: { path: string } }).file
							if (!selection || !file) return
							this.chat.addUserContext(
								createSelectedTextContextItem({
									type: 'selection',
									filePath: file.path,
									range: { from: selection.anchor, to: selection.head },
									selectedText: editor.getSelection(),
								}),
							)
							void this.openChatbox()
						})
				})
			})
		})
		scope.register(() => workspace.offref(menuEvent))
		void scope.background(
			() => this.mcp.reload(),
			(error) => logger.error(error),
		)
		void scope.background(
			() => this.gateway.initializeProviderFromStoredAuth(),
			(error) => logger.error(error),
		)
	}

	private async stop() {
		for (const type of [
			CHATBOX_VIEW_TYPE,
			MEMORY_EDITOR_VIEW_TYPE,
			APP_VIEW_TYPE,
		]) {
			for (const leaf of this.plugin.app.workspace.getLeavesOfType(type))
				leaf.detach()
		}
		this.gateway?.onunload()
		await this.apps?.settle()
		await this.workspaces?.logs.settle()
		await Promise.all([this.chat?.suspend(), this.mcp?.close()])
	}

	async openChatbox() {
		if (!this.lifecycle.active) return
		const scope = this.lifecycle.scope
		const workspace = this.plugin.app.workspace
		const inEditor =
			this.plugin.localSettings.ai.chatboxLocation === ChatboxLocation.Editor
		const existing = workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)
		const leaf =
			existing.find((leaf) => {
				const root = leaf.getRoot()
				return inEditor
					? root === workspace.rootSplit
					: root === workspace.leftSplit || root === workspace.rightSplit
			}) ??
			(inEditor ? workspace.getLeaf('tab') : workspace.getRightLeaf(false))
		if (!leaf) return
		// Chat state belongs to ChatService; replacing its host preserves the session
		// and draft while ensuring subsequent opens use the device's chosen area.
		for (const previous of existing) {
			if (previous !== leaf) previous.detach()
		}
		await leaf.setViewState({ type: CHATBOX_VIEW_TYPE, active: true })
		if (scope.signal.aborted) {
			leaf.detach()
			return
		}
		void workspace.revealLeaf(leaf)
	}

	async editApp(id: string) {
		await this.chat.createSession()
		await this.chat.selectWorkspace(id)
		await this.openChatbox()
	}

	appIcon(id: string, iconSvg?: string) {
		const icon = appIconId(id)
		if (iconSvg) {
			try {
				const svg = validateAppIcon(
					iconSvg,
					this.plugin.app.workspace.containerEl.ownerDocument,
				)
				addIcon(icon, appIconContent(svg))
			} catch {
				// Fallback icon handles invalid or pending SVG definitions.
			}
		}
		return icon
	}

	async openApp(id: string) {
		if (!this.lifecycle.active) return
		const scope = this.lifecycle.scope
		const saved = await this.apps.read(id)
		scope.check()
		const workspace = this.plugin.app.workspace
		const existing = workspace
			.getLeavesOfType(APP_VIEW_TYPE)
			.find((candidate) => candidate.view.getState().appId === id)
		if (existing) {
			void workspace.revealLeaf(existing)
			return saved
		}
		const leaf = workspace.getLeaf('tab')
		await leaf.setViewState({
			type: APP_VIEW_TYPE,
			state: { appId: id },
			active: true,
		})
		if (scope.signal.aborted) {
			leaf.detach()
			return
		}
		void workspace.revealLeaf(leaf)
		return saved
	}
}
