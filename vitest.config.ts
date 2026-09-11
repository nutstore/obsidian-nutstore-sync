import { defineConfig } from 'vitest/config'
import solid from 'unplugin-solid/vite'

export default defineConfig({
	plugins: [solid({ hot: false })],
	resolve: {
		alias: {
			'~': new URL('./src', import.meta.url).pathname,
		},
	},
	test: {
		environment: 'node',
		// Match the package, not our src/components/solid-js directory.
		server: { deps: { external: [/^solid-js(?:\/|$)/] } },
		setupFiles: ['./test/vitest.setup.ts'],
	},
})
