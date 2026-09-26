import * as db from './db'
import { tryFetchJson } from './http'

// Free, keyless daily rates (https://www.exchangerate-api.com/docs/free).
const RATES_URL = 'https://open.er-api.com/v6/latest/USD'
const MAX_AGE_MS = 12 * 3_600_000

/** Refreshes exchange rates at most twice a day; keeps the last good set on failure. */
export async function refreshRates(): Promise<void> {
  const updated = db.ratesUpdatedAt()
  if (updated && Date.now() - new Date(updated).getTime() < MAX_AGE_MS) return
  const data = await tryFetchJson<{ result?: string; rates?: Record<string, number> }>(RATES_URL)
  if (data?.result === 'success' && data.rates) db.saveRates(data.rates)
}
