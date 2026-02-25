/**
 * Extended type definitions for Obsidian API
 *
 * This file contains type definitions for undocumented/internal Obsidian APIs
 * that are not included in the official obsidian type definitions.
 *
 * Note: These are internal APIs that may change in future Obsidian versions.
 * Use with caution and proper error handling.
 */

import 'obsidian'

/**
 * Obsidian's internal Setting object
 * Provides access to the settings modal and plugin tabs
 */
interface ObsidianSetting {
	/**
	 * Opens the settings modal
	 */
	open(): void

	/**
	 * Opens a specific plugin's settings tab
	 * @param pluginId - The plugin manifest ID
	 */
	openTabById(pluginId: string): void
}

declare module 'obsidian' {
	interface App {
		/**
		 * Internal settings API (undocumented)
		 * Used to programmatically open the settings modal and navigate to plugin tabs
		 *
		 * Warning: This is an internal API and may not be available in all Obsidian versions.
		 * Always check for existence before using.
		 */
		setting?: ObsidianSetting
	}
}
