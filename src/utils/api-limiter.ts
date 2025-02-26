import Bottleneck from 'bottleneck'

export const apiLimiter = new Bottleneck({
	maxConcurrent: 1,
})
