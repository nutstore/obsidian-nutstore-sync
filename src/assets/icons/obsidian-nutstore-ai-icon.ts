import { addIcon } from 'obsidian'
import source from './obsidian_nutstore_ai_icon.svg?raw'

export const CHATBOX_AI_ICON_ID = 'nutstore-ai'

// The source artwork is black; use the surrounding text color so it remains
// visible in both Obsidian themes.
export const chatboxAiIconInlineSvg = source.replaceAll(
	'#000000',
	'currentColor',
)

const iconContent = chatboxAiIconInlineSvg
	.replace(/^<svg\b[^>]*>/, '')
	.replace(/<\/svg>\s*$/, '')

// Obsidian supplies the outer 100 × 100 SVG. Its `addIcon` API accepts only
// SVG contents, so fit this source artwork's 64 × 64 coordinate space into it.
export const chatboxAiIconContent = `<g transform="scale(1.5625)">${iconContent}</g>`

export function registerChatboxAiIcon() {
	addIcon(CHATBOX_AI_ICON_ID, chatboxAiIconContent)
}
