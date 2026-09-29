import type { Colorway, Gender, Size } from '@shared/types'
import * as db from '../db'
import { HttpError, fetchText, sleep } from '../http'
import type { RawProduct } from './types'

// Shared machinery for stores that only offer HTML pages and dislike being
// crawled (Japanese brand shops such as Auralee and Kapital). Each sync reads
// just the category listings, which carry names, prices and links, so price
// changes and removals are still seen every time. Product pages, which hold
// sizes and stock, are read slowly and cached: new items first, then the ones
// checked longest ago, a limited number per sync.
const DELAY_MS = 3000
const MAX_DETAILS_PER_SYNC = 40

/** Sizes, colours and stock read from a product page. */
export interface ItemDetail {
  sizes: Size[]
  colors: Colorway[]
  images?: string[]
  descriptionHtml?: string
  available: boolean
}

/** Fetches pages one at a time with a pause between them. */
export function pacer(delay = DELAY_MS) {
  let last = 0
  return async (url: string) => {
    const wait = last + delay - Date.now()
    if (wait > 0) await sleep(wait)
    try {
      return await fetchText(url, 'text/html', 0)
    } finally {
      last = Date.now()
    }
  }
}

/** Whether the user's department setting wants a section of this gender. */
export function wanted(gender: Gender | null): boolean {
  const pref = db.getSettings().gender
  return pref === 'all' || !gender || gender === 'unisex' || gender === pref
}

/**
 * Reads a page for each item slowly and remembers the result: items never read
 * come first, then those read longest ago (only once older than `maxAgeDays`),
 * at most MAX_DETAILS_PER_SYNC per sync. Stops as soon as the store pushes back.
 * Returns what's known for every item, fresh or remembered.
 */
export async function readSlowly<T>(
  store: string,
  ids: string[],
  read: (id: string) => Promise<T | null>,
  maxAgeDays = 0
): Promise<Map<string, T>> {
  const cache = db.detailCache(store)
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()
  const due = ids
    .filter((id) => (cache.get(id)?.fetchedAt ?? '') <= cutoff)
    .sort((a, b) => (cache.get(a)?.fetchedAt ?? '').localeCompare(cache.get(b)?.fetchedAt ?? ''))
  for (const id of due.slice(0, MAX_DETAILS_PER_SYNC)) {
    try {
      const data = await read(id)
      if (data) {
        db.saveDetail(store, id, data)
        cache.set(id, { data, fetchedAt: new Date().toISOString() })
      }
    } catch (e) {
      if (e instanceof HttpError && (e.status === 403 || e.status === 429)) break
    }
  }
  const out = new Map<string, T>()
  for (const id of ids) {
    const hit = cache.get(id)
    if (hit) out.set(id, hit.data as T)
  }
  return out
}

/** Fills listing-only products with product-page details (sizes, stock), read slowly. */
export async function withDetails(
  store: string,
  items: RawProduct[],
  read: (item: RawProduct) => Promise<ItemDetail | null>
): Promise<RawProduct[]> {
  const byId = new Map(items.map((i) => [i.externalId, i]))
  const details = await readSlowly(store, [...byId.keys()], (id) => read(byId.get(id)!))
  return items.map((item) => {
    const d = details.get(item.externalId)
    if (!d) return item
    return {
      ...item,
      sizes: d.sizes,
      colors: d.colors,
      images: d.images?.length ? d.images : item.images,
      descriptionHtml: d.descriptionHtml || item.descriptionHtml,
      available: d.available
    }
  })
}

const SYMBOLS: [RegExp, string][] = [
  [/\$|USD/, 'USD'],
  [/¥|円|JPY/, 'JPY'],
  [/€|EUR/, 'EUR'],
  [/£|GBP/, 'GBP']
]

/** Amounts and currency from a price text like "$3,261.50" or "¥74,800 → ¥52,360". */
export function readPrices(text: string): { amounts: number[]; currency: string | null } {
  const amounts = [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter((n) => n > 0)
  return { amounts, currency: SYMBOLS.find(([re]) => re.test(text))?.[1] ?? null }
}
