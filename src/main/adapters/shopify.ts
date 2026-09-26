import type { Colorway, Gender, Size } from '@shared/types'
import { load } from 'cheerio'
import { collectionGender, isKids, isSizeOption } from '../classify'
import { fetchJson, fetchText, HttpError, mapLimit, sleep, tryFetchJson } from '../http'
import type { Adapter, FetchResult, RawProduct } from './types'

interface ShopifyVariant {
  id: number
  title: string
  option1: string | null
  option2: string | null
  option3: string | null
  price: string
  compare_at_price: string | null
  available?: boolean
  featured_image?: { src: string } | null
}

interface ShopifyProduct {
  id: number
  title: string
  handle: string
  body_html: string | null
  vendor: string
  product_type: string
  tags: string[] | string
  variants: ShopifyVariant[]
  options: { name: string; position: number; values: string[] }[]
  images: { src: string; variant_ids?: number[] }[]
}

/**
 * Stores whose main site isn't in English often publish an English version
 * under a locale path (e.g. /en-us). Returns that path, or '' to use the root
 * (including stores whose English version is the root itself).
 */
async function englishPath(base: string): Promise<string> {
  let html: string
  try {
    html = await fetchText(base)
  } catch {
    return ''
  }
  // The page's own lang attribute isn't reliable: stores redirect English-speaking
  // visitors to their English pages while the root feed stays in the home language.
  const $ = load(html)
  const bare = (h: string) => h.replace(/^www\./, '')
  const host = bare(new URL(base).host)
  const alternates = $('link[rel="alternate"][hreflang]')
    .map((_, el) => ({ lang: ($(el).attr('hreflang') ?? '').toLowerCase(), href: $(el).attr('href') ?? '' }))
    .get()
    .filter((a) => a.lang.startsWith('en') && a.href)
  const pick = ['en-us', 'en', 'en-gb'].map((l) => alternates.find((a) => a.lang === l)).find(Boolean) ?? alternates[0]
  if (!pick) return ''
  try {
    const u = new URL(pick.href, base)
    if (bare(u.host) !== host) return ''
    const path = u.pathname.replace(/\/$/, '')
    if (!path) return ''
    const probe = await tryFetchJson<{ products?: unknown[] }>(`${base}${path}/products.json?limit=1`)
    return Array.isArray(probe?.products) ? path : ''
  } catch {
    return ''
  }
}

const PAGE_SIZE = 250
const MAX_PAGES = 120

async function fetchCollection(base: string, path: string, onPage?: (n: number) => void) {
  const all: ShopifyProduct[] = []
  let complete = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    let data: { products: ShopifyProduct[] }
    try {
      data = await fetchJson(`${base}${path}/products.json?limit=${PAGE_SIZE}&page=${page}`)
    } catch (e) {
      // Shopify refuses deep pages on very large catalogues; keep what we have
      // and leave `complete` false so nothing gets marked as removed.
      if (page > 1 && e instanceof HttpError && e.status === 400) break
      throw e
    }
    all.push(...data.products)
    onPage?.(all.length)
    if (data.products.length < PAGE_SIZE) {
      complete = true
      break
    }
    await sleep(350)
  }
  return { products: all, complete }
}

interface ShopifyCollection {
  handle: string
  title: string
  products_count?: number
}

// The few largest collections per gender cover nearly every product; more
// only adds minutes of downloading on big stores.
const MAX_COLLECTIONS_PER_GENDER = 4
const COLLECTION_CONCURRENCY = 3

/**
 * Labels products using the store's own men's/women's collections. The
 * largest few per gender cover almost everything; a product found in both
 * is unisex. Products in a kids' collection are reported separately.
 */
async function genderMembership(base: string): Promise<{ genders: Map<number, Gender>; kids: Set<number> }> {
  const collections: ShopifyCollection[] = []
  for (let page = 1; page <= 4; page++) {
    const data = await tryFetchJson<{ collections: ShopifyCollection[] }>(`${base}/collections.json?limit=250&page=${page}`)
    if (!data?.collections?.length) break
    collections.push(...data.collections)
    if (data.collections.length < 250) break
  }

  const largest = (match: (c: ShopifyCollection) => boolean, n: number) =>
    collections
      .filter((c) => (c.products_count ?? 1) > 0 && match(c))
      .sort((a, b) => (b.products_count ?? 0) - (a.products_count ?? 0))
      .slice(0, n)
  const jobs: { handle: string; label: 'men' | 'women' | 'kids' }[] = [
    ...largest((c) => collectionGender(c.handle, c.title) === 'men', MAX_COLLECTIONS_PER_GENDER).map((c) => ({ handle: c.handle, label: 'men' as const })),
    ...largest((c) => collectionGender(c.handle, c.title) === 'women', MAX_COLLECTIONS_PER_GENDER).map((c) => ({ handle: c.handle, label: 'women' as const })),
    ...largest((c) => isKids(c.handle, c.title), 3).map((c) => ({ handle: c.handle, label: 'kids' as const }))
  ]

  const found = new Map<number, Set<'men' | 'women'>>()
  const kids = new Set<number>()
  await mapLimit(jobs, COLLECTION_CONCURRENCY, async ({ handle, label }) => {
    try {
      for (const p of (await fetchCollection(base, `/collections/${handle}`)).products) {
        if (label === 'kids') kids.add(p.id)
        else (found.get(p.id) ?? found.set(p.id, new Set()).get(p.id)!).add(label)
      }
    } catch {
      /* membership is a hint only */
    }
  })

  const map = new Map<number, Gender>()
  for (const [id, set] of found) map.set(id, set.size === 2 ? 'unisex' : [...set][0])
  return { genders: map, kids }
}

function toRaw(base: string, p: ShopifyProduct, currency: string | null, gender: Gender | null, kids: boolean): RawProduct {
  const variants = p.variants ?? []
  const sizeOptIndex = (p.options ?? []).findIndex((o) => isSizeOption(o.name))
  // A lone non-default option (e.g. "Title: S") is almost always size.
  const onlyOption = p.options?.length === 1 && p.options[0].name !== 'Title' ? 0 : -1
  const idx = sizeOptIndex >= 0 ? sizeOptIndex : onlyOption

  // Every other real option (Color, Lens, Frame, Finish…) describes the colourway.
  const colorIdx = (p.options ?? [])
    .map((o, i) => (i !== idx && o.name !== 'Title' && !isSizeOption(o.name) ? i : -1))
    .filter((i) => i >= 0)
  const colors: Colorway[] = []
  if (colorIdx.length) {
    const byName = new Map<string, Colorway>()
    const colourOfVariant = new Map<number, string>()
    for (const v of variants) {
      const name = colorIdx
        .map((i) => v[`option${i + 1}` as 'option1' | 'option2' | 'option3'])
        .filter((x): x is string => !!x && x !== 'Default Title')
        .join(' / ')
      if (!name) continue
      colourOfVariant.set(v.id, name)
      const image = v.featured_image?.src ?? p.images?.find((im) => im.variant_ids?.includes(v.id))?.src ?? null
      const c = byName.get(name) ?? { name, available: false, image, images: [] }
      c.available ||= v.available !== false
      c.image ??= image
      byName.set(name, c)
    }
    // Stores usually tag only the first photo of each colour; the untagged
    // photos that follow it belong to the same colour.
    let current: string | null = null
    for (const im of p.images ?? []) {
      const tagged = im.variant_ids?.map((id) => colourOfVariant.get(id)).find(Boolean)
      if (tagged) current = tagged
      if (current) byName.get(current)?.images!.push(im.src)
    }
    for (const c of byName.values()) if (!c.images!.length && c.image) c.images = [c.image]
    colors.push(...byName.values())
  }

  let sizes: Size[] = []
  if (idx >= 0) {
    const key = `option${idx + 1}` as 'option1' | 'option2' | 'option3'
    const bySize = new Map<string, boolean>()
    for (const v of variants) {
      // "54-17RX" is the same frame fitted with prescription lenses, not another size.
      const label = v[key]?.replace(/\s*[-/]?\s*RX$/i, '').trim()
      if (!label || label === 'Default Title') continue
      bySize.set(label, (bySize.get(label) ?? false) || v.available !== false)
    }
    sizes = [...bySize].map(([label, available]) => ({ label, available }))
  }

  const inStock = variants.filter((v) => v.available !== false)
  const pool = inStock.length ? inStock : variants
  const cheapest = pool.reduce<ShopifyVariant | null>(
    (best, v) => (!best || parseFloat(v.price) < parseFloat(best.price) ? v : best),
    null
  )
  const price = cheapest ? parseFloat(cheapest.price) : 0
  const compare = cheapest?.compare_at_price ? parseFloat(cheapest.compare_at_price) : null

  return {
    externalId: String(p.id),
    handle: p.handle,
    title: p.title,
    brand: p.vendor || '',
    descriptionHtml: p.body_html || '',
    url: `${base}/products/${p.handle}`,
    productType: p.product_type || '',
    tags: Array.isArray(p.tags) ? p.tags : (p.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    images: (p.images ?? []).map((i) => i.src),
    price,
    compareAtPrice: compare && compare > price ? compare : null,
    currency,
    sizes,
    colors: colors.length > 1 ? colors : [],
    available: inStock.length > 0,
    collectionGender: gender,
    kids
  }
}

export const shopify: Adapter = {
  platform: 'shopify',

  async detect(base) {
    const data = await tryFetchJson<{ products?: unknown[] }>(`${base}/products.json?limit=1`)
    return Array.isArray(data?.products)
  },

  async fetchAll(base, onProgress): Promise<FetchResult> {
    // Read the English catalogue when the store has one, so titles and
    // descriptions come through in English (and product links open in English).
    const root = base + (await englishPath(base))
    const cart = await tryFetchJson<{ currency?: string }>(`${root}/cart.js`)
    const currency = cart?.currency ?? null
    const { products, complete } = await fetchCollection(root, '', onProgress)
    const { genders, kids } = await genderMembership(root)
    return {
      products: products.map((p) => toRaw(root, p, currency, genders.get(p.id) ?? null, kids.has(p.id))),
      currency,
      complete
    }
  }
}
