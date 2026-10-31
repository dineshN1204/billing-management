/**
 * Failure-proof async helpers.
 *
 * Why this exists
 * ---------------
 * The recurring "the page is stuck, refresh and it works" report was caused by a
 * single shape repeated across the app:
 *
 *     void Promise.all([a, b]).then(([x, y]) => { setLoading(false) })
 *
 * If either request rejects - a dropped connection, a tab whose session lapsed
 * mid-flight, a DNS failure on a phone - `.then` never runs, `setLoading(false)`
 * never runs, and the spinner stays on screen forever with no error and no retry.
 * Reloading remounts the component and the retry succeeds, which is exactly why
 * the only known remedy was "refresh a few times".
 *
 * A Data API builder is a thenable that resolves with an `error` field for
 * *query* failures but *rejects* for transport failures, so both shapes have to
 * be handled. These helpers normalise both into a value, which means a caller can
 * always clear its loading flag, and they keep each step's failure separate so a
 * page can say which request failed instead of collapsing everything into one
 * generic sentence.
 */

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

export function isOk<T>(result: Settled<T>): result is { ok: true; value: T } {
  return result.ok
}

/** Runs one step. Never rejects. */
export async function settle<T>(run: () => PromiseLike<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Runs every step even when an earlier one failed, and reports each result
 * independently. Ordering is preserved, so callers destructure positionally.
 */
export async function settleAll<T extends readonly unknown[]>(
  runs: { [K in keyof T]: () => PromiseLike<T[K]> },
): Promise<{ [K in keyof T]: Settled<T[K]> }> {
  return Promise.all(runs.map(run => settle(run))) as Promise<{ [K in keyof T]: Settled<T[K]> }>
}

/** The first failure in a settled list, or null when everything succeeded. */
export function firstError(results: readonly Settled<unknown>[]): unknown {
  for (const result of results) if (!result.ok) return result.error
  return null
}

/**
 * Runs an async step that owns a loading flag, and guarantees the flag is
 * cleared - whether the step succeeded, failed, or was a no-op.
 */
export async function withLoading(
  setLoading: (busy: boolean) => void,
  setError: (message: string) => void,
  run: () => Promise<void>,
): Promise<void> {
  setLoading(true)
  setError('')
  try {
    await run()
  } catch (cause) {
    setError(String((cause as { message?: unknown } | null)?.message ?? cause))
  } finally {
    setLoading(false)
  }
}