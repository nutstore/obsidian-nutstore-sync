import { createConsola, LogLevels } from 'consola'

const logger = createConsola({
	level: LogLevels.verbose,
	formatOptions: {
		date: true,
		colors: false,
	},
})

export default logger
