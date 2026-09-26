import type { Gender, Size } from '@shared/types'
import { collectionGender, isSizeOption } from '../classify'
import { fetchJson, HttpError, sleep, tryFetchJson } from '../http'
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
  images: { src: string }[]
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

const MAX_COLLECTIONS_PER_GENDER = 10

/**
 * Labels products using the store's own men's/women's collections. The
 * largest few per gender cover almost everything; a product found in both
 * is unisex.
 */
async function genderMembership(base: string): Promise<Map<number, Gender>> {
  const collections: ShopifyCollection[] = []
  for (let page = 1; page <= 4; page++) {
    const data = await tryFetchJson<{ collections: ShopifyCollection[] }>(`${base}/collections.json?limit=250&page=${page}`)
    if (!data?.collections?.length) break
    collections.push(...data.collections)
    if (data.collections.length < 250) break
  }

  const found = new Map<number, Set<'men' | 'women'>>()
  for (const gender of ['men', 'women'] as const) {
    const picks = collections
      .filter((c) => (c.products_count ?? 1) > 0 && collectionGender(c.handle, c.title) === gender)
      .sort((a, b) => (b.products_count ?? 0) - (a.products_count ?? 0))
      .slice(0, MAX_COLLECTIONS_PER_GENDER)
    for (const c of picks) {
      try {
        const { products } = await fetchCollection(base, `/collections/${c.handle}`)
        for (const p of products) (found.get(p.id) ?? found.set(p.id, new Set()).get(p.id)!).add(gender)
      } catch {
        /* membership is a hint only */
      }
    }
  }

  const map = new Map<number, Gender>()
  for (const [id, set] of found) map.set(id, set.size === 2 ? 'unisex' : [...set][0])
  return map
}

function toRaw(base: string, p: ShopifyProduct, currency: string | null, gender: Gender | null): RawProduct {
  const variants = p.variants ?? []
  const sizeOptIndex = (p.options ?? []).findIndex((o) => isSizeOption(o.name))
  // A lone non-default option (e.g. "Title: S") is almost always size.
  const onlyOption = p.options?.length === 1 && p.options[0].name !== 'Title' ? 0 : -1
  const idx = sizeOptIndex >= 0 ? sizeOptIndex : onlyOption

  let sizes: Size[] = []
  if (idx >= 0) {
    const key = `option${idx + 1}` as 'option1' | 'option2' | 'option3'
    const bySize = new Map<string, boolean>()
    for (const v of variants) {
      const label = v[key]
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
    available: inStock.length > 0,
    collectionGender: gender
  }
}

export const shopify: Adapter = {
  platform: 'shopify',

  async detect(base) {
    const data = await tryFetchJson<{ products?: unknown[] }>(`${base}/products.json?limit=1`)
    return Array.isArray(data?.products)
  },

  async fetchAll(base, onProgress): Promise<FetchResult> {
    const cart = await tryFetchJson<{ currency?: string }>(`${base}/cart.js`)
    const currency = cart?.currency ?? null
    const { products, complete } = await fetchCollection(base, '', onProgress)
    const genders = await genderMembership(base)
    return {
      products: products.map((p) => toRaw(base, p, currency, genders.get(p.id) ?? null)),
      currency,
      complete
    }
  }
}
