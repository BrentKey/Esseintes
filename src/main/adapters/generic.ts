import { load } from 'cheerio'
import type { Gender, Size } from '@shared/types'
import { collectionGender } from '../classify'
import { fetchText, mapLimit, sleep } from '../http'
import type { Adapter, FetchResult, RawProduct } from './types'

// Fallback for stores that aren't Shopify/WooCommerce: walk the sitemap and
// read the schema.org Product data that most shops embed for search engines.
// Slower than an API, so the number of product pages per sync is capped.
const MAX_PRODUCT_URLS = 800
const CONCURRENCY = 4
const PRODUCT_URL = /\/(products?|p|item|items|shop|store|goods)\/[^/]+/i

async function sitemapUrls(base: string): Promise<string[]> {
  const roots: string[] = []
  try {
    const robots = await fetchText(`${base}/robots.txt`, 'text/plain', 0)
    for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) roots.push(m[1])
  } catch {
    /* no robots.txt */
  }
  if (!roots.length) roots.push(`${base}/sitemap.xml`, `${base}/sitemap_index.xml`)

  const pages: string[] = []
  const seen = new Set<string>()
  const queue = [...roots]
  let fetched = 0
  while (queue.length && fetched < 25) {
    const url = queue.shift()!
    if (seen.has(url)) continue
    seen.add(url)
    let xml: string
    try {
      xml = await fetchText(url, 'application/xml,text/xml', 0)
      fetched++
    } catch {
      continue
    }
    const $ = load(xml, { xml: true })
    const children = $('sitemap > loc').map((_, el) => $(el).text().trim()).get()
    if (children.length) {
      // Prefer product sitemaps; otherwise explore everything.
      const productMaps = children.filter((c) => /product/i.test(c))
      queue.push(...(productMaps.length ? productMaps : children))
      continue
    }
    const fromProductMap = /product/i.test(url)
    for (const loc of $('url > loc').map((_, el) => $(el).text().trim()).get()) {
      if (fromProductMap || PRODUCT_URL.test(new URL(loc, base).pathname)) pages.push(loc)
    }
  }
  return [...new Set(pages)]
}

type Json = Record<string, any>

function findProduct(node: unknown): Json | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findProduct(n)
      if (f) return f
    }
    return null
  }
  const obj = node as Json
  const type = ([] as string[]).concat(obj['@type'] ?? [])
  if (type.includes('Product') || type.includes('ProductGroup')) return obj
  return findProduct(obj['@graph'])
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v]
}

function imageUrls(v: unknown): string[] {
  return asArray(v as any)
    .map((i: any) => (typeof i === 'string' ? i : i?.url || i?.contentUrl))
    .filter((s: unknown): s is string => typeof s === 'string')
}

const inStock = (a: unknown) => !a || /InStock|LimitedAvailability|PreOrder|OnlineOnly/i.test(String(a))

function centraProduct($: ReturnType<typeof load>): Json | null {
  const raw = $('script#__NEXT_DATA__').contents().text()
  if (!raw.includes('"centra"')) return null
  try {
    const page = JSON.parse(raw)?.props?.pageProps
    return (page?.centra ?? page?.pageProps?.centra)?.product ?? null
  } catch {
    return null
  }
}

export function parseProduct(url: string, html: string): RawProduct | null {
  const $ = load(html)
  let product: Json | null = null
  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return
    try {
      product = findProduct(JSON.parse($(el).contents().text()))
    } catch {
      /* malformed JSON-LD */
    }
  })
  if (!product) return null
  const p = product as Json

  const variants: Json[] = asArray(p.hasVariant)
  const offers: Json[] = asArray(p.offers).flatMap((o: Json) => (o?.offers ? asArray(o.offers) : [o]))
  const allOffers = offers.concat(variants.flatMap((v) => asArray(v.offers)))
  const prices = allOffers
    .map((o) => ({
      price: parseFloat(o.price ?? o.lowPrice),
      currency: o.priceCurrency,
      available: inStock(o.availability),
      strike: asArray(o.priceSpecification).find((s: Json) => /Strikethrough|ListPrice/i.test(s?.priceType ?? ''))
    }))
    .filter((o) => !isNaN(o.price))
  if (!prices.length) return null
  // Every offer, in stock or not: a cheaper size selling out isn't a price change.
  const best = prices.reduce((a, b) => (b.price < a.price ? b : a))
  const strike = best.strike ? parseFloat(best.strike.price) : NaN

  const sizes: Size[] = []
  const bySize = new Map<string, boolean>()
  for (const v of variants) {
    const label = v.size?.name ?? v.size
    if (typeof label !== 'string') continue
    const ok = asArray(v.offers).some((o: Json) => inStock(o.availability))
    bySize.set(label, (bySize.get(label) ?? false) || ok)
  }
  for (const [label, available] of bySize) sizes.push({ label, available })

  const byColor = new Map<string, { name: string; available: boolean; image: string | null }>()
  for (const v of variants) {
    const name = typeof v.color === 'string' ? v.color : null
    if (!name) continue
    const c = byColor.get(name) ?? { name, available: false, image: imageUrls(v.image)[0] ?? null }
    c.available ||= asArray(v.offers).some((o: Json) => inStock(o.availability))
    byColor.set(name, c)
  }

  const brand = typeof p.brand === 'string' ? p.brand : (p.brand?.name ?? '')
  let images = imageUrls(p.image).concat(variants.flatMap((v) => imageUrls(v.image)))
  let available = prices.some((o) => o.available)

  // Centra shops built on Next.js (e.g. Our Legacy) embed the full product record,
  // with stock per size, which their JSON-LD leaves out.
  const centra = centraProduct($)
  if (centra) {
    sizes.length = 0
    for (const s of asArray<Json>(centra.items ?? centra.sizes))
      if (typeof s?.name === 'string') sizes.push({ label: s.name, available: s.stock !== 'no' && s.stock !== false })
    available = centra.available !== false && (!sizes.length || sizes.some((s) => s.available))
    const media = asArray<string>(centra.media?.full ?? centra.media?.standard).filter((m) => typeof m === 'string')
    if (media.length) images = media
    else if (Array.isArray(centra.media?.full)) images = []
  }

  // Centra also says which department the item is in ("MENS", "WOMENS") and its
  // category (["MENS", "JERSEY"]); the names alone often don't.
  const department = String(centra?.Department_text ?? asArray<string>(centra?.categoryName)[0] ?? '')
  const gender: Gender | null = /\bunisex\b/i.test(department) ? 'unisex' : collectionGender(department, department)
  const centraCategory = asArray<string>(centra?.categoryName).filter((n) => typeof n === 'string').slice(1).join(' ')
  const category = [p.category, $('meta[property="product:category"]').attr('content'), centraCategory].filter(Boolean).join(' ')

  return {
    externalId: url,
    handle: new URL(url).pathname.split('/').filter(Boolean).pop() ?? '',
    title: String(p.name ?? $('meta[property="og:title"]').attr('content') ?? '').trim(),
    brand,
    descriptionHtml: String(p.description ?? ''),
    url,
    productType: typeof category === 'string' ? category : '',
    tags: [],
    images: [...new Set(images)],
    price: best.price,
    compareAtPrice: !isNaN(strike) && strike > best.price ? strike : null,
    currency: best.currency ?? null,
    sizes,
    colors: byColor.size > 1 ? [...byColor.values()] : [],
    available,
    collectionGender: gender
  }
}

export const generic: Adapter = {
  platform: 'generic',

  async detect() {
    return true
  },

  async fetchAll(base, onProgress): Promise<FetchResult> {
    const urls = await sitemapUrls(base)
    const capped = urls.slice(0, MAX_PRODUCT_URLS)
    let failures = 0
    let attempted = 0
    let blocked = false
    const products: RawProduct[] = []
    await mapLimit(capped, CONCURRENCY, async (url) => {
      // Stop early when the first pages yield nothing: the site is blocking us
      // or doesn't publish product data, and trying 800 pages won't change that.
      if (blocked || (attempted >= 20 && !products.length)) {
        blocked = true
        return
      }
      attempted++
      try {
        const p = parseProduct(url, await fetchText(url, 'text/html', 1))
        if (p?.title) products.push(p)
      } catch {
        failures++
      }
      onProgress(products.length)
      await sleep(250)
    })
    if (!urls.length) throw new Error('No product sitemap found. This store may block automated access or not be supported yet.')
    if (!products.length)
      throw new Error(`Found ${urls.length} product pages but couldn't read product details from them. The store may block automated access.`)
    return {
      products,
      currency: products[0]?.currency ?? null,
      complete: urls.length <= MAX_PRODUCT_URLS && failures < capped.length * 0.1,
      source: base
    }
  }
}
