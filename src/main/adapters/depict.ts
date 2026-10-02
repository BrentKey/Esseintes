import { load } from 'cheerio'
import type { Gender, Size } from '@shared/types'
import { collectionCategory, collectionGender, isKids } from '../classify'
import { fetchJson, fetchText, HttpError, postJson, sleep } from '../http'
import { parseProduct } from './generic'
import { wanted } from './gentle'
import type { Adapter, FetchResult, RawProduct } from './types'

// Stores whose product listings are served by Depict (api.depict.ai), e.g.
// Centra shops like OAS. Their pages are heavy and ask crawlers to go slowly,
// but the listing API returns whole categories with sizes and stock, so a sync
// takes a handful of requests instead of one per product.
const API = 'https://api.depict.ai/v3'
const PER_PAGE = 200 // the API's maximum
const MAX_PAGES = 20
const PAUSE_MS = 1000

interface Listing {
  listing_id: string
  listing_type: string
  external_id?: string
  title: string
  slug?: string
  children?: Listing[]
}

interface VariantDisplay {
  display_item_id: string
  uri: string
  title: string
  variant_name?: string | null
  size_name?: string | null
  size?: string | null
  image_urls?: string[]
  product_type_display_name?: string[] | null
  attr_garment_type?: string[] | null
  gender_display_name?: string[] | null
  department?: string | null
  sale_price: number
  original_price: number
  in_stock: boolean
}

interface ListingPage {
  displays: { variant_index?: number; variant_displays: VariantDisplay[] }[]
  n_hits: number
  cursor?: string
}

interface Storefront {
  root: string
  /** Country segment in the store's URLs ("us" in oascompany.com/us/…), if it uses one. */
  urlMarket: string | null
  market: string
  merchant: string
}

/** The storefront's market and the Depict merchant id from its script bundle. */
async function storefront(base: string): Promise<Storefront> {
  const html = await fetchText(base)
  // The homepage redirects to the visitor's country version; its canonical link says which.
  const canonical = load(html)('link[rel="canonical"]').attr('href')
  const url = new URL(canonical || base, base)
  const urlMarket = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? null
  // React builds ship the merchant in main.*.js, Next.js builds in the _app chunk.
  let merchant: string | undefined
  for (const bundle of html.match(/\/(?:static\/js\/main\.[\w.-]+|_next\/static\/chunks\/pages\/_app-[\w.-]+)\.js/g) ?? []) {
    merchant = (await fetchText(`${url.origin}${bundle}`, '*/*')).match(/merchant:"([\w-]+)"/)?.[1]
    if (merchant) break
  }
  if (!merchant) throw new Error('Couldn’t find the store’s product listing service.')
  // Stores without a country in their URLs (a "global" site) list under Depict's "us" market.
  const market = urlMarket && /^[a-z]{2}$/.test(urlMarket) ? urlMarket : 'us'
  return { root: url.origin, urlMarket: urlMarket && /^[a-z]{2}(-[a-z]+)?$/.test(urlMarket) ? urlMarket : null, market, merchant }
}

function sectionGender(title: string): Gender | null {
  return /\bunisex\b/i.test(title) ? 'unisex' : collectionGender('', title)
}

/** The product's own department ("MENS", gender "Female"), else its section's. */
function genderOf(v: VariantDisplay, section: Gender | null): Gender | null {
  const g = [...(v.gender_display_name ?? []), v.department ?? ''].join(' ')
  if (/unisex/i.test(g)) return 'unisex'
  if (/female|\bwomen|\bwomens\b/i.test(g)) return 'women'
  if (/\bmale\b|\bmens?\b/i.test(g)) return 'men'
  return section
}

const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : s)

function toRaw(store: Storefront, d: ListingPage['displays'][number], gender: Gender | null, category: string | null): RawProduct {
  const variants = d.variant_displays
  const v = variants[d.variant_index ?? 0] ?? variants[0]
  const sizes: Size[] = variants
    .map((s) => ({ label: s.size_name ?? s.size ?? '', available: s.in_stock }))
    .filter((s) => s.label && !/^one ?size$/i.test(s.label))
  const type = v.attr_garment_type?.[0] ?? v.product_type_display_name?.[0] ?? ''
  const name = titleCase(v.title.trim())
  // Stores that give the colour separately (Our Legacy) get "Name – Colour", so colourways group.
  const title = v.variant_name ? `${name} – ${v.variant_name.trim()}` : name
  const url = store.urlMarket ? `${store.root}/${store.urlMarket}/${v.uri}` : `${store.root}/${v.uri}`
  return {
    externalId: v.display_item_id,
    handle: v.uri,
    title,
    brand: '',
    descriptionHtml: '',
    url,
    productType: v.product_type_display_name?.join(' ') ?? category ?? '',
    tags: [],
    images: v.image_urls ?? [],
    price: v.sale_price,
    compareAtPrice: v.original_price > v.sale_price ? v.original_price : null,
    currency: null,
    sizes,
    colors: [],
    available: variants.some((s) => s.in_stock),
    collectionGender: genderOf(v, gender),
    storeCategory: (type && collectionCategory('', type)) || (category && collectionCategory('', category)) || null
  }
}

export const depict: Adapter = {
  platform: 'depict',

  async detect(base) {
    try {
      // React builds embed INITIAL_DEPICT_CONTEXT; Next.js builds a "depict" block in
      // their page data, though not always on the homepage, so check their app script.
      const html = await fetchText(base, 'text/html', 0)
      if (/INITIAL_DEPICT_CONTEXT|"depict":\{/.test(html)) return true
      const app = html.match(/\/_next\/static\/chunks\/pages\/_app-[\w.-]+\.js/)?.[0]
      return !!app && /api\.depict\.ai[\s\S]*merchant:"[\w-]+"|merchant:"[\w-]+"[\s\S]*api\.depict\.ai/.test(await fetchText(new URL(app, base).toString(), '*/*', 0))
    } catch {
      return false
    }
  },

  async fetchAll(base, onProgress): Promise<FetchResult> {
    const store = await storefront(base)
    const { merchant, market } = store
    // Depict locales are "en_US" for some stores and plain "en" for others.
    let locale = ''
    let listings: Listing[] = []
    for (const l of ['en_US', 'en']) {
      listings = await fetchJson<Listing[]>(`${API}/listings?merchant=${merchant}&market=${market}&locale=${l}`)
      if (listings.length) {
        locale = l
        break
      }
    }
    if (!locale) throw new Error('Couldn’t read the store’s product listings.')

    const byId = new Map<string, RawProduct>()
    let complete = true
    let requests = 0
    // Hides duplicate "secondary" entries, as OAS's own pages do; stores without
    // that field reject it, so it's dropped after the first refusal.
    let filters: unknown[] | undefined = [{ field: 'attr_secondary_display', data: ['false'], op: 'in' }]

    /** Every product in a listing, following its pages. */
    async function products(id: string): Promise<ListingPage['displays'] | null> {
      const out: ListingPage['displays'] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        if (requests++) await sleep(PAUSE_MS)
        const body = { merchant, market, locale, limit: PER_PAGE, ...(cursor ? { cursor } : {}) }
        let data: ListingPage
        try {
          data = await postJson<ListingPage>(`${API}/listings/${id}/products`, filters ? { ...body, filters } : body)
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 422 && filters)) throw e
          filters = undefined
          data = await postJson<ListingPage>(`${API}/listings/${id}/products`, body)
        }
        out.push(...data.displays)
        if (!data.cursor || !data.displays.length || out.length >= data.n_hits) return out
        cursor = data.cursor
      }
      complete = false
      return out
    }

    /**
     * Reads a section; stores that only list products in sub-sections (Our Legacy's
     * "MENS" is empty, "MENS › JERSEY" isn't) are read a level down.
     */
    async function read(l: Listing, gender: Gender | null, depth: number): Promise<void> {
      const g = sectionGender(l.title) ?? gender
      if (!wanted(g) || isKids(l.title, l.slug ?? '') || /gift ?card/i.test(l.title)) return
      const found = await products(l.listing_id)
      if (!found?.length) {
        if (depth < 2) for (const child of l.children ?? []) if (child.listing_type === 'category') await read(child, g, depth + 1)
        return
      }
      for (const d of found) {
        if (!d.variant_displays?.length) continue
        const p = toRaw(store, d, g, depth ? l.title : null)
        const prev = byId.get(p.externalId)
        // Found in both the men's and women's sections: unisex.
        if (prev && prev.collectionGender && p.collectionGender && prev.collectionGender !== p.collectionGender) prev.collectionGender = 'unisex'
        else if (prev && !prev.storeCategory && p.storeCategory) prev.storeCategory = p.storeCategory
        else if (!prev) byId.set(p.externalId, p)
      }
      onProgress(byId.size)
    }

    // The store's departments: its men's/women's/unisex sections, plus sections such as
    // accessories or footwear when the store files those separately.
    const top = listings.filter((l) => l.listing_type === 'category')
    const gendered = top.filter((l) => sectionGender(l.title))
    if (!gendered.length) throw new Error('Couldn’t find the store’s men’s or women’s section.')
    const departments = [...gendered, ...top.filter((l) => !sectionGender(l.title) && DEPARTMENT.test(l.title))]
    for (const l of departments) await read(l, null, 0)

    // Listings carry no currency; read it from one product page.
    const products_ = [...byId.values()]
    let currency: string | null = null
    if (products_.length) {
      try {
        currency = parseProduct(products_[0].url, await fetchText(products_[0].url, 'text/html', 1))?.currency ?? null
      } catch {
        /* falls back to the store's last known currency */
      }
    }
    for (const p of products_) p.currency = currency
    return { products: products_, currency, complete, source: `${store.root}/${market}` }
  }
}

// Top-level sections that are departments in their own right, not campaigns or seasons.
const DEPARTMENT = /^(accessories|footwear|shoes|bags|eyewear|jewel(le)?ry|work ?shop|home(ware)?|lifestyle)$/i
