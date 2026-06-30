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
import type { EditorView } from '@codemirror/view'

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

	interface MenuItem {
		/**
		 * Creates a submenu for this menu item.
		 * Internal Obsidian API, available at runtime but missing from older typings.
		 */
		setSubmenu(): this

		/**
		 * Submenu instance created by setSubmenu().
		 */
		submenu?: Menu
	}

	interface Editor {
		/**
		 * Obsidian's CM6 EditorView instance.
		 * Internal/undocumented, but present at runtime in markdown editors.
		 */
		cm?: EditorView
	}
}
