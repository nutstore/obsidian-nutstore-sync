import type * as fc from 'fast-check'

const DEFAULT_SIM_SEED = 20261123

function parseOptionalInt(value: string | undefined): number | undefined {
	if (!value) return undefined
	const parsed = Number.parseInt(value, 10)
	return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Shared configuration for deterministic simulation and property-based tests.
 *
 * - Default CI runs use a fixed seed and fast run budgets (~3s total).
 * - Local stress campaigns can crank coverage via `SIM_RUNS=1000 SIM_SEED=... pnpm test:sim`.
 */
export function getSimSeed(offset = 0): number {
	const base = parseOptionalInt(process.env.SIM_SEED) ?? DEFAULT_SIM_SEED
	return base + offset
}

export function getSimRuns(defaultRuns: number): number {
	const override = parseOptionalInt(process.env.SIM_RUNS)
	if (override && override > 0) {
		return override
	}
	return defaultRuns
}

export function simParams<T = unknown>(
	defaultRuns: number,
	seedOffset = 0,
): fc.Parameters<T> {
	return {
		seed: getSimSeed(seedOffset),
		numRuns: getSimRuns(defaultRuns),
		endOnFailure: false,
	}
}
