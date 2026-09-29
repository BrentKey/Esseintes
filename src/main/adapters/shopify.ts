import type { Colorway, Gender, Size } from '@shared/types'
import { load } from 'cheerio'
import { collectionCategory, collectionGender, isKids, isSizeOption } from '../classify'
import * as db from '../db'
import { fetchJson, fetchText, HttpError, mapLimit, sleep, tryFetchJson } from '../http'
import { pacer, readSlowly } from './gentle'
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
  sku?: string | null
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
const COLLECTION_CONCURRENCY = 4
const MAX_CATEGORY_COLLECTIONS = 24
const MAX_MENU_COLLECTIONS_PER_GENDER = 20

/** Handles of the collections linked from the store's homepage menus. */
async function menuCollections(base: string): Promise<Set<string>> {
  try {
    const html = await fetchText(base)
    return new Set([...html.matchAll(/href="(?:https?:\/\/[^"/]+)?(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/collections\/([\w-]+)\/?["?#]/gi)].map((m) => m[1].toLowerCase()))
  } catch {
    return new Set()
  }
}

// A collection's membership is re-read when its product count changes, or after this long.
const MEMBERSHIP_TTL_MS = 24 * 3_600_000

/**
 * Product ids in a collection, reusing the copy saved by an earlier sync while
 * the collection's product count is unchanged and the copy is under a day old.
 */
async function collectionIds(base: string, handle: string, count: number | null): Promise<number[]> {
  const store = `${new URL(base).host}#collections`
  const saved = db.detailCache(store).get(handle) as { data: { count: number | null; ids: number[] }; fetchedAt: string } | undefined
  if (saved && saved.data.count === count && Date.now() - new Date(saved.fetchedAt).getTime() < MEMBERSHIP_TTL_MS) return saved.data.ids
  try {
    const ids = (await fetchCollection(base, `/collections/${handle}`)).products.map((p) => p.id)
    db.saveDetail(store, handle, { count, ids })
    return ids
  } catch (e) {
    // A stale copy beats no labels at all.
    if (saved) return saved.data.ids
    throw e
  }
}

/**
 * Labels products using the store's own men's/women's collections. The
 * largest few per gender cover almost everything; a product found in both
 * is unisex. Products in a kids' collection are reported separately.
 */
async function genderMembership(
  base: string
): Promise<{ genders: Map<number, Gender>; kids: Set<number>; categories: Map<number, string> }> {
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
  // The store's own category collections ("Shirts", "Running Pants"): up to two of
  // the largest per category, skipping catch-alls that hold half the catalogue.
  const biggest = Math.max(1, ...collections.map((c) => c.products_count ?? 0))
  const byCategory = new Map<string, ShopifyCollection[]>()
  for (const c of collections) {
    const cat = collectionCategory(c.handle, c.title)
    if (!cat || !(c.products_count ?? 1) || (c.products_count ?? 0) > biggest * 0.5) continue
    byCategory.set(cat, [...(byCategory.get(cat) ?? []), c])
  }
  const categoryJobs = [...byCategory]
    .flatMap(([cat, cs]) =>
      cs
        .sort((a, b) => (b.products_count ?? 0) - (a.products_count ?? 0))
        .slice(0, 2)
        .map((c) => ({ handle: c.handle, label: 'category' as const, cat, size: c.products_count ?? Infinity }))
    )
    .slice(0, MAX_CATEGORY_COLLECTIONS)

  const jobs: { handle: string; label: 'men' | 'women' | 'kids' | 'category'; cat?: string; size?: number }[] = [
    ...categoryJobs,
    ...largest((c) => collectionGender(c.handle, c.title) === 'men', MAX_COLLECTIONS_PER_GENDER).map((c) => ({ handle: c.handle, label: 'men' as const })),
    ...largest((c) => collectionGender(c.handle, c.title) === 'women', MAX_COLLECTIONS_PER_GENDER).map((c) => ({ handle: c.handle, label: 'women' as const })),
    ...largest((c) => isKids(c.handle, c.title), 3).map((c) => ({ handle: c.handle, label: 'kids' as const }))
  ]

  // Prefer the sections the store's own menus link to ("Men > Shirts", "Women > Dresses"):
  // together they cover each department, where the largest few can miss pieces.
  const menu = await menuCollections(base)
  for (const g of ['men', 'women'] as const) {
    const linked = collections.filter((c) => menu.has(c.handle) && (c.products_count ?? 1) > 0 && collectionGender(c.handle, c.title) === g)
    if (linked.length < 2) continue
    const keep = jobs.filter((j) => j.label !== g)
    jobs.length = 0
    jobs.push(...keep, ...linked.slice(0, MAX_MENU_COLLECTIONS_PER_GENDER).map((c) => ({ handle: c.handle, label: g })))
  }

  const found = new Map<number, Set<'men' | 'women'>>()
  const kids = new Set<number>()
  // For each product, the category of the smallest (most specific) collection it's in.
  const categories = new Map<number, { cat: string; size: number }>()
  const counts = new Map(collections.map((c) => [c.handle, c.products_count ?? null]))
  await mapLimit(jobs, COLLECTION_CONCURRENCY, async ({ handle, label, cat, size }) => {
    try {
      for (const id of await collectionIds(base, handle, counts.get(handle) ?? null)) {
        if (label === 'kids') kids.add(id)
        else if (label === 'category') {
          const prev = categories.get(id)
          if (!prev || size! < prev.size) categories.set(id, { cat: cat!, size: size! })
        } else (found.get(id) ?? found.set(id, new Set()).get(id)!).add(label)
      }
    } catch {
      /* membership is a hint only */
    }
  })

  const map = new Map<number, Gender>()
  for (const [id, set] of found) map.set(id, set.size === 2 ? 'unisex' : [...set][0])
  return { genders: map, kids, categories: new Map([...categories].map(([id, c]) => [id, c.cat])) }
}

const COLOUR_OPTION = /\b(colou?rs?|colou?rways?|couleurs?|coloris|colori|colore|farben?|colou?res)\b/i

/** Words of a name or file name, space-padded for whole-word matching: "SIRA_E-1-side-1" → " sira e 1 side 1 ". */
const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `

/** A photo's file name without extension, Shopify's upload suffix or size, so copies of one photo compare equal. */
function photoBase(src: string): string {
  return (src.split('?')[0].split('/').pop() ?? '')
    .toLowerCase()
    .replace(/\.(jpe?g|png|webp|gif)$/, '')
    .replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '')
    .replace(/_(\d+x\d*|grande|large|medium|small|compact|master)$/, '')
    // Theme asset copies: "8516e1fa8ba0--AHLEM-FW26-ELYSEE-Champagne-02-92aaa9".
    .replace(/^[0-9a-f]{12}--/, '')
    .replace(/-[0-9a-f]{6}$/, '')
}

/**
 * The parts of variant SKUs that identify a colour ("M3141.SG.BG.50" → "bg"):
 * segments with one value per colour, different for every colour.
 */
function skuCodes(variants: ShopifyVariant[], colourOfVariant: Map<number, string>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const segs = variants.map((v) => (v.sku ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  for (let i = 0; i < Math.max(0, ...segs.map((s) => s.length)); i++) {
    const byColour = new Map<string, Set<string>>()
    variants.forEach((v, j) => {
      const colour = colourOfVariant.get(v.id)
      if (colour && segs[j][i]) (byColour.get(colour) ?? byColour.set(colour, new Set()).get(colour)!).add(segs[j][i])
    })
    const codes = [...byColour.values()].map((set) => [...set])
    if (codes.length < 2 || codes.some((c) => c.length !== 1)) continue
    if (new Set(codes.map((c) => c[0])).size !== codes.length) continue
    for (const [colour, set] of byColour) out.set(colour, [...(out.get(colour) ?? []), ...set])
  }
  return out
}

/**
 * Gives each colour its photos. Stores formally link only one photo to each
 * colour, so the rest are found by file name when the store names files after
 * the colour ("Palais-Garnier_Champagne_1_grey.jpg", "SIRA_E-1-side-1.jpg") or
 * its SKU code ("m3141-bg-50-pedestal.jpg"). Stores that don't name files that
 * way usually put a colour's photos right after its linked one.
 */
function assignPhotos(
  p: ShopifyProduct,
  variants: ShopifyVariant[],
  byName: Map<string, Colorway>,
  colourOfVariant: Map<number, string>,
  pagePhotos: string[]
) {
  const codes = skuCodes(variants, colourOfVariant)
  const keys = new Map<string, string[]>()
  for (const name of byName.keys()) {
    const parts = [name, ...name.split(' / '), ...(codes.get(name) ?? [])]
    keys.set(name, [...new Set(parts.map(words))].filter((k) => k.replace(/ /g, '').length >= 2))
  }
  // Longest matching key wins ("peony gold" over "gold"); a tie means no match.
  const byFileName = (src: string): string | null => {
    const w = words(photoBase(src))
    let best: string | null = null
    let bestLen = 0
    let tie = false
    for (const [name, ks] of keys) {
      const len = Math.max(0, ...ks.filter((k) => w.includes(k)).map((k) => k.length))
      if (len > bestLen) [best, bestLen, tie] = [name, len, false]
      else if (len && len === bestLen && name !== best) tie = true
    }
    return tie ? null : best
  }

  const tagged = new Map<string, string>() // photo base → colour, from the store's own links
  for (const im of p.images ?? []) {
    const colour = im.variant_ids?.map((id) => colourOfVariant.get(id)).find(Boolean)
    if (colour) tagged.set(photoBase(im.src), colour)
  }
  const owners = (p.images ?? []).map((im) => {
    const base = photoBase(im.src)
    return { src: im.src, owner: tagged.get(base) ?? null, named: tagged.has(base) ? null : byFileName(im.src) }
  })
  const namesFiles = owners.some((o) => o.named)
  let current: string | null = null
  for (const o of owners) {
    const owner = o.owner ?? o.named
    if (owner) current = owner
    else if (namesFiles) continue // unnamed photos in a named set belong to no one colour
    if (current) byName.get(current)?.images!.push(o.src)
  }

  // Photos only shown on the product page: kept when named after this product and one colour.
  const handleWords = words(p.handle).trim().split(' ').filter((w) => w.length >= 3)
  const known = new Set((p.images ?? []).map((im) => photoBase(im.src)))
  for (const src of pagePhotos) {
    const base = photoBase(src)
    if (known.has(base) || !handleWords.some((h) => words(base).includes(` ${h} `))) continue
    const owner = byFileName(src)
    if (!owner) continue
    known.add(base)
    byName.get(owner)?.images!.push(src)
  }

  // Lead each colour with the photo the store linked to it; one copy of each photo.
  for (const c of byName.values()) {
    const seen = new Set<string>()
    c.images = (c.image ? [c.image, ...c.images!] : c.images!).filter((src) => !seen.has(photoBase(src)) && !!seen.add(photoBase(src)))
  }
}

/** Product photos in a product page's HTML (Shopify CDN files and theme assets), full size. */
export function pagePhotos(html: string): string[] {
  const found = new Map<string, string>()
  // Pages also embed URLs inside JSON, with escaped slashes.
  const text = html.replace(/\\\//g, '/')
  for (const m of text.matchAll(/(?:https?:)?\/\/[^"'\s()]+?\/(?:cdn\/shop\/files|s\/files\/[\d/]+\/(?:files|t\/\d+\/assets))\/[^"'\s?()]+?\.(?:jpe?g|png|webp)/gi)) {
    const url = (m[0].startsWith('//') ? `https:${m[0]}` : m[0]).replace(/_(\d+x\d*|grande|large|medium|small|compact|master)(\.\w+)$/, '$2')
    const base = photoBase(url)
    if (!found.has(base)) found.set(base, url)
  }
  return [...found.values()]
}

// Page photos rarely change; re-read a product's page after this long.
const PAGE_PHOTOS_MAX_AGE_DAYS = 30

const RX = /\s*[-/]?\s*RX$/i
const isPrescription = (v: ShopifyVariant) => [v.option1, v.option2, v.option3, v.title].some((o) => !!o && RX.test(o.trim()))

function toRaw(
  base: string,
  p: ShopifyProduct,
  currency: string | null,
  gender: Gender | null,
  kids: boolean,
  /** Extra photos found on the product's own page (see pagePhotos). */
  pagePhotos: string[] = []
): RawProduct {
  const variants = p.variants ?? []
  const sizeOptIndex = (p.options ?? []).findIndex((o) => isSizeOption(o.name))
  // A lone non-default option (e.g. "Title: S") is almost always size, unless
  // it's named as colour (eyewear shops often sell each frame in colours only).
  const onlyOption = p.options?.length === 1 && p.options[0].name !== 'Title' && !COLOUR_OPTION.test(p.options[0].name) ? 0 : -1
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
    assignPhotos(p, variants, byName, colourOfVariant, pagePhotos)
    for (const c of byName.values()) if (!c.images!.length && c.image) c.images = [c.image]
    colors.push(...byName.values())
  }

  let sizes: Size[] = []
  if (idx >= 0) {
    const key = `option${idx + 1}` as 'option1' | 'option2' | 'option3'
    const bySize = new Map<string, boolean>()
    for (const v of variants) {
      // "54-17RX" is the same frame fitted with prescription lenses, not another size.
      const label = v[key]?.replace(RX, '').trim()
      if (!label || label === 'Default Title') continue
      bySize.set(label, (bySize.get(label) ?? false) || v.available !== false)
    }
    sizes = [...bySize].map(([label, available]) => ({ label, available }))
  }

  // Eyewear stores list a cheaper prescription-ready version ("49-22RX", frame
  // only) beside each frame; it isn't the item's price, and its appearing
  // would otherwise look like a markdown. Price from the regular versions.
  const regular = variants.filter((v) => !isPrescription(v))
  const priced = regular.length ? regular : variants
  const inStock = variants.filter((v) => v.available !== false)
  const pricedInStock = priced.filter((v) => v.available !== false)
  const pool = pricedInStock.length ? pricedInStock : priced
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
    images: [...new Set([...(p.images ?? []).map((i) => i.src), ...colors.flatMap((c) => c.images ?? [])])],
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
    // Collections are looked up on the main site: translated handles (e.g. Boglioli's
    // "uomo" shown as "man" under /en-us) often return nothing in the English catalogue.
    const { genders, kids, categories } = await genderMembership(base)
    const raw = (p: ShopifyProduct, photos?: string[]) => ({
      ...toRaw(root, p, currency, genders.get(p.id) ?? null, kids.has(p.id), photos),
      storeCategory: categories.get(p.id) ?? null
    })
    let raws = products.map((p) => raw(p))

    // Some stores (eyewear especially) keep most photos off the product feed and
    // only show them on the product page. Where colours mostly have a single
    // photo, read those pages slowly, once per product, and remember them.
    const thin = (r: RawProduct) => r.colors.length > 1 && r.colors.filter((c) => (c.images?.length ?? 0) <= 1).length > r.colors.length / 2
    const multi = raws.filter((r) => r.colors.length > 1)
    if (multi.length >= 3 && multi.filter(thin).length >= multi.length / 2) {
      const get = pacer()
      const needing = products.filter((_, i) => thin(raws[i]))
      const urls = new Map(needing.map((p) => [String(p.id), `${root}/products/${p.handle}`]))
      const pages = await readSlowly(
        `${new URL(base).host}#pagephotos`,
        [...urls.keys()],
        async (id) => ({ photos: pagePhotos(await get(urls.get(id)!)) }),
        PAGE_PHOTOS_MAX_AGE_DAYS
      )
      raws = products.map((p, i) => (pages.has(String(p.id)) ? raw(p, pages.get(String(p.id))!.photos) : raws[i]))
    }
    return {
      products: raws,
      currency,
      complete,
      source: root
    }
  }
}
