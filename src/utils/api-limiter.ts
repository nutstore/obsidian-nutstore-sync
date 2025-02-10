import Bottleneck from 'bottleneck'

export const apiLimiter = new Bottleneck({
	maxConcurrent: 2,
	minTime: 1000,
})
