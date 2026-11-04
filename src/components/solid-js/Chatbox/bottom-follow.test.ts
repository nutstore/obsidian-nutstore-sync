import { describe, expect, it } from 'vitest'
import { observeBottomFollow } from './bottom-follow'

describe('bottom follow', () => {
	it('keeps following when delayed layout growth is observed mid-stream', () => {
		expect(
			observeBottomFollow({
				following: true,
				previousScrollTop: 120,
				currentScrollTop: 120,
				distanceFromBottom: 420,
			}),
		).toBe(true)
	})

	it('keeps following through a programmatic downward scroll', () => {
		expect(
			observeBottomFollow({
				following: true,
				previousScrollTop: 120,
				currentScrollTop: 240,
				distanceFromBottom: 68,
			}),
		).toBe(true)
	})

	it('stops as soon as the user scrolls upward', () => {
		expect(
			observeBottomFollow({
				following: true,
				previousScrollTop: 240,
				currentScrollTop: 220,
				distanceFromBottom: 20,
			}),
		).toBe(false)
	})

	it('resumes when a paused reader returns near the bottom', () => {
		expect(
			observeBottomFollow({
				following: false,
				previousScrollTop: 220,
				currentScrollTop: 240,
				distanceFromBottom: 48,
			}),
		).toBe(true)
	})
})
