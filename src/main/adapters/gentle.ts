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
 * Fills listing-only products with cached product-page details, reading a few
 * more product pages this sync. Stops reading as soon as the store pushes back.
 */
export async function withDetails(
  store: string,
  items: RawProduct[],
  read: (item: RawProduct) => Promise<ItemDetail | null>
): Promise<RawProduct[]> {
  const cache = db.detailCache(store)
  const queue = [...items].sort((a, b) => (cache.get(a.externalId)?.fetchedAt ?? '').localeCompare(cache.get(b.externalId)?.fetchedAt ?? ''))
  for (const item of queue.slice(0, MAX_DETAILS_PER_SYNC)) {
    try {
      const detail = await read(item)
      if (detail) {
        db.saveDetail(store, item.externalId, detail)
        cache.set(item.externalId, { data: detail, fetchedAt: new Date().toISOString() })
      }
    } catch (e) {
      if (e instanceof HttpError && (e.status === 403 || e.status === 429)) break
    }
  }
  return items.map((item) => {
    const d = cache.get(item.externalId)?.data as ItemDetail | undefined
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
