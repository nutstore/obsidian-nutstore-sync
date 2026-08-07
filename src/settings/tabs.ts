export const SETTINGS_TABS = [
	{ key: 'sync', i18nKey: 'settings.tabs.sync' },
	{ key: 'ai', i18nKey: 'settings.tabs.ai' },
	{ key: 'troubleshooting', i18nKey: 'settings.tabs.troubleshooting' },
] as const

export type SettingsTabKey = (typeof SETTINGS_TABS)[number]['key']
