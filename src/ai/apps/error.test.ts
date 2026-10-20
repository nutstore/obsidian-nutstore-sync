import { describe, expect, it } from 'vitest'
import { appError } from './error'

describe('App diagnostics', () => {
	it('retains the original response, stack and cause in multilingual failures', () => {
		const cause = new Error('来源暂不可用 Source unavailable 🌿')
		const error = Object.assign(
			new Error('检索失败 Retrieval failed 🧭', { cause }),
			{
				statusCode: 503,
				responseBody: '{"detail":"笔记暂不可用 Notes unavailable 📘"}',
			},
		)
		const diagnostic = appError(error)
		expect(diagnostic).toContain(error.stack)
		expect(diagnostic).toContain('statusCode: 503')
		expect(diagnostic).toContain('Notes unavailable 📘')
		expect(diagnostic).toContain(cause.message)
	})
	it('retains structured failures and stops circular cause chains', () => {
		expect(appError({ detail: '中性依据 Neutral evidence 📘' })).toContain(
			'中性依据 Neutral evidence 📘',
		)
		const error = Object.assign(new Error('中性错误 Neutral failure 🌿'), {
			cause: undefined as unknown,
		})
		error.cause = error
		expect(appError(error)).toContain('Caused by: [Circular]')
	})
})
