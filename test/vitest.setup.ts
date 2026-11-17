import { webcrypto } from 'node:crypto'
import { LogLevels } from 'consola'
import logger from '~/utils/logger'

if (!globalThis.crypto) {
	globalThis.crypto = webcrypto as Crypto
}

logger.level = LogLevels.silent
