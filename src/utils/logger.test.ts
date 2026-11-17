import type { ConsolaInstance, ConsolaReporter, LogObject } from 'consola'
import { LogLevels } from 'consola'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `test/vitest.setup.ts` pins the shared instance to `LogLevels.silent` so a
 * normal test cannot leak log output. These tests therefore load a fresh copy
 * of the module twice: once with the shipped (non-development) environment to
 * observe what a release build is configured with, and once with
 * `NODE_ENV=development` to observe the development-only console reporter.
 */
async function loadLogger(): Promise<ConsolaInstance> {
	vi.resetModules()
	const module = await import('~/utils/logger')
	return module.default
}

function createCapturingReporter(entries: LogObject[]): ConsolaReporter {
	return {
		log: (logObj) => {
			entries.push(logObj)
		},
	}
}

afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	vi.resetModules()
	vi.useRealTimers()
})

describe('logger configuration', () => {
	it('captures debug, info, warn and error at its configured level', async () => {
		const logger = await loadLogger()
		expect(logger.level).toBe(LogLevels.verbose)

		const entries: LogObject[] = []
		logger.addReporter(createCapturingReporter(entries))

		logger.debug('调试 线索 🌿')
		logger.info('信息 就绪 ✅')
		logger.warn('警告 重试 ⚠️')
		logger.error('错误 收尾 ❌')

		expect(entries.map((entry) => entry.type)).toEqual([
			'debug',
			'info',
			'warn',
			'error',
		])
		expect(entries.map((entry) => entry.args)).toEqual([
			['调试 线索 🌿'],
			['信息 就绪 ✅'],
			['警告 重试 ⚠️'],
			['错误 收尾 ❌'],
		])
	})

	it('delivers repeated identical calls: consola throttle dedupe is disabled', async () => {
		const logger = await loadLogger()
		const entries: LogObject[] = []
		logger.addReporter(createCapturingReporter(entries))

		const line = '重复事件 repeated event 🔁'
		logger.info(line)
		logger.info(line)

		// Two consecutive identical calls both reach the reporter.
		expect(entries).toHaveLength(2)

		// Consola's default throttle starts swallowing identical calls after a
		// handful of repeats; a bounded sink must see every one of them.
		for (let index = 0; index < 6; index++) {
			logger.info(line)
		}
		expect(entries).toHaveLength(8)
		expect(entries.every((entry) => entry.args[0] === line)).toBe(true)
	})

	it('honours runtime level changes: silent suppresses, restore resumes', async () => {
		const logger = await loadLogger()
		const entries: LogObject[] = []
		logger.addReporter(createCapturingReporter(entries))

		logger.info('可见前')
		logger.level = LogLevels.silent
		logger.info('静默中的信息')
		logger.error('静默中的错误')
		expect(entries).toHaveLength(1)

		logger.level = LogLevels.verbose
		logger.info('恢复后的信息')
		expect(entries.map((entry) => entry.args)).toEqual([
			['可见前'],
			['恢复后的信息'],
		])
	})

	it('attaches no console reporter in a shipped build', async () => {
		const logger = await loadLogger()

		expect(logger.options.reporters).toEqual([])

		// Real observable behavior: a release build must stay silent because the
		// only log consumer is the in-app retention sink.
		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(() => true)
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(() => true)

		logger.info('发行构建不应输出 🌙')

		expect(stdoutSpy).not.toHaveBeenCalled()
		expect(stderrSpy).not.toHaveBeenCalled()
	})

	it('keeps a console reporter in a development build', async () => {
		vi.stubEnv('NODE_ENV', 'development')
		const logger = await loadLogger()

		expect(logger.options.reporters.length).toBeGreaterThan(0)

		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(() => true)
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(() => true)

		logger.info('开发构建输出 🌱')

		const writeCount = stdoutSpy.mock.calls.length + stderrSpy.mock.calls.length
		expect(writeCount).toBeGreaterThan(0)
	})
})
