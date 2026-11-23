import { defineConfig } from 'vitest/config'
import solid from 'unplugin-solid/vite'

const UI_TEST_PATTERNS = [
	'src/**/*.test.tsx',
	'src/components/*.test.ts',
	'src/views/app.view.test.ts',
	'src/views/chatbox.view.test.ts',
	'src/ai/apps/runtime.test.ts',
	'src/ai/apps/source.test.ts',
	'src/ai/apps/theme.test.ts',
	'src/ai/apps/workspaces.test.ts',
	'src/utils/scoped-ribbon-icon.test.ts',
]

const BUILD_TEST_PATTERNS = [
	'scripts/esbuild/**/*.test.{ts,mjs}',
	'test/build/**/*.build.test.ts',
]

const SIM_TEST_PATTERNS = ['test/sim/**/*.sim.test.ts']

export default defineConfig({
	plugins: [solid({ hot: false })],
	resolve: {
		alias: {
			'~': new URL('./src', import.meta.url).pathname,
			'@test': new URL('./test', import.meta.url).pathname,
			obsidian: new URL('./test/obsidian-runtime.ts', import.meta.url).pathname,
		},
	},
	test: {
		pool: 'threads',
		environment: 'node',
		// Match the package, not our src/components/solid-js directory.
		server: { deps: { external: [/^solid-js(?:\/|$)/] } },
		setupFiles: ['./test/vitest.setup.ts'],
		benchmark: {
			include: ['test/bench/**/*.bench.ts'],
		},
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					environment: 'node',
					isolate: false,
					include: ['src/**/*.test.ts'],
					exclude: [...UI_TEST_PATTERNS, '**/node_modules/**'],
				},
			},
			{
				extends: true,
				test: {
					name: 'ui',
					environment: 'jsdom',
					isolate: false,
					include: UI_TEST_PATTERNS,
				},
			},
			{
				extends: true,
				test: {
					name: 'sim',
					environment: 'node',
					include: SIM_TEST_PATTERNS,
					testTimeout: 30_000,
				},
			},
			{
				extends: true,
				test: {
					name: 'build',
					environment: 'node',
					include: BUILD_TEST_PATTERNS,
					testTimeout: 30_000,
				},
			},
		],
	},
})
