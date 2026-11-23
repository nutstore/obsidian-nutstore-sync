import type { App } from 'obsidian'
import type { AIProviderConfig } from '~/ai/core/types'
import type NutstorePlugin from '~/index'
import type { ModuleState } from '~/modules/lifecycle'
import type { ChatboxLocation, SessionAppOpenMode } from '~/settings'
import { assert } from './assert'

/**
 * Protocol string constants and type-only projections shared by E2E checks.
 *
 * The integration harness deliberately NEVER imports runtime values from `~/...`
 * so esbuild cannot bundle a second copy of production code into the harness;
 * every check must exercise the loaded production `main.js` plugin instance.
 */
export const PLUGIN_ID = 'nutstore-sync'
export const CHATBOX_VIEW_TYPE = 'nutstore-sync-chatbox'
export const APP_VIEW_TYPE = 'nutstore-app'

export const APP_ROOT_DIR = '.agents/nutstore-sync/apps'
export const APP_MANIFEST_FILE = 'manifest.json'
export const APP_ENTRY_FILE = 'index.html'
export const APP_DATA_FILE = 'data.json'
export const APP_STATE_FILE = 'state.json'
export const SKILLS_ROOT = '.agents/skills'

export const MODULE_STATE = {
	Enabled: 'enabled' as ModuleState,
	Disabled: 'disabled' as ModuleState,
} as const

export const CHATBOX_LOCATION = {
	Sidebar: 'sidebar' as ChatboxLocation,
	Editor: 'editor' as ChatboxLocation,
} as const

export const SESSION_APP_OPEN_MODE = {
	Automatic: 'automatic' as SessionAppOpenMode,
	Manual: 'manual' as SessionAppOpenMode,
} as const

export function appDirectoryPath(id: string): string {
	return `${APP_ROOT_DIR}/${id}`
}

export function getProductionPlugin(app: App): NutstorePlugin {
	const plugins = (
		app as unknown as { plugins: { plugins: Record<string, unknown> } }
	).plugins
	const plugin = plugins.plugins[PLUGIN_ID] as NutstorePlugin | undefined
	assert(plugin, 'Nutstore Sync production plugin is not loaded')
	return plugin
}

export function createNeutralProvider(
	id: string,
	name: string,
	modelName = 'Neutral model / 中性模型 🌱',
): AIProviderConfig {
	return {
		id,
		name,
		npm: '@ai-sdk/openai-compatible',
		env: [],
		doc: '',
		api: 'https://example.test/v1',
		apiKey: 'neutral-key',
		models: {
			'neutral-model': {
				id: 'neutral-model',
				name: modelName,
				attachment: false,
				reasoning: false,
				tool_call: true,
				temperature: true,
				release_date: '',
				last_updated: '',
				modalities: { input: ['text'], output: ['text'] },
				open_weights: false,
				limit: { context: 0, output: 0 },
			},
		},
	}
}
