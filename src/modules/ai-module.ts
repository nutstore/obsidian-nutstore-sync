import type NutstorePlugin from '~/index'
import { createSelectedTextContextItem } from '~/ai/chat/context/user-context'
import { CHATBOX_AI_ICON_ID } from '~/assets/icons/obsidian-nutstore-ai-icon'
import ChatService from '~/services/chat.service'
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
import { ModuleLifecycle, type ModuleScope } from './lifecycle'

/** All AI entry points and background resources belong to this lifetime. */
export class AiModule {
	chat!: ChatService
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
		this.chat = new ChatService(this.plugin, scope)
		this.models.initializeFromLocalSettings()
		this.conflicts.onload()
		scope.register(() => this.conflicts.onunload())
		const icon = this.plugin.addRibbonIcon(
			CHATBOX_AI_ICON_ID,
			i18n.t('chatbox.openCommand'),
			() => {
				if (!scope.signal.aborted) void this.openChatbox()
			},
		)
		scope.register(() => icon.remove())
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
		for (const type of [CHATBOX_VIEW_TYPE, MEMORY_EDITOR_VIEW_TYPE]) {
			for (const leaf of this.plugin.app.workspace.getLeavesOfType(type))
				leaf.detach()
		}
		this.gateway?.onunload()
		await Promise.all([this.chat?.suspend(), this.mcp?.close()])
	}

	async openChatbox() {
		if (!this.lifecycle.active) return
		const scope = this.lifecycle.scope
		const workspace = this.plugin.app.workspace
		const leaf =
			workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)[0] ||
			workspace.getRightLeaf(false)
		if (!leaf) return
		await leaf.setViewState({ type: CHATBOX_VIEW_TYPE, active: true })
		if (scope.signal.aborted) {
			leaf.detach()
			return
		}
		void workspace.revealLeaf(leaf)
	}
}
