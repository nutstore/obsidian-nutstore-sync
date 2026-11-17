const NEAR_BOTTOM_THRESHOLD_PX = 48

export function observeBottomFollow(input: {
	following: boolean
	previousScrollTop: number
	currentScrollTop: number
	distanceFromBottom: number
}): boolean {
	if (input.currentScrollTop < input.previousScrollTop) return false
	if (input.distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX) return true
	return input.following
}
