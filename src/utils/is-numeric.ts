import { isFinite } from 'lodash-es'

export function isNumeric(val: any) {
	return !isNaN(parseFloat(val)) && isFinite(Number(val))
}
