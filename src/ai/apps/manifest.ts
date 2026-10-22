import { z } from 'zod/mini'
import { APP_DEFAULT_ICON } from './icon'

export const appManifestSchema = z.object({
	schemaVersion: z.literal(1),
	title: z.string().check(z.minLength(1)),
	iconSvg: z.string().check(z.minLength(1)),
	/** V1 keeps a stable JSON data contract across code upgrades. */
	dataVersion: z.literal(1),
})
export type AppManifest = z.infer<typeof appManifestSchema>
export function emptyAppManifest(title: string): AppManifest {
	return {
		schemaVersion: 1,
		title,
		iconSvg: APP_DEFAULT_ICON,
		dataVersion: 1,
	}
}
