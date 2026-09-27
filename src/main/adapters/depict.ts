import { load } from 'cheerio'
import type { Gender, Size } from '@shared/types'
import { collectionCategory, collectionGender } from '../classify'
import { fetchJson, fetchText, postJson, sleep } from '../http'
import { parseProduct } from './generic'
import type { Adapter, FetchResult, RawProduct } from './types'

// Stores whose product listings are served by Depict (api.depict.ai), e.g.
// Centra shops like OAS. Their pages are heavy and ask crawlers to go slowly,
// but the listing API returns whole categories with sizes and stock, so a sync
// takes a handful of requests instead of one per product.
const API = 'https://api.depict.ai/v3'
const PER_PAGE = 200 // the API's maximum
const MAX_PAGES = 20

interface Listing {
  listing_type: string
  external_id?: string
  title: string
  slug?: string
}

interface VariantDisplay {
  display_item_id: string
  uri: string
  title: string
  size_name?: string | null
  size?: string | null
  image_urls?: string[]
  product_type_display_name?: string[] | null
  attr_garment_type?: string[] | null
  gender_display_name?: string[] | null
  sale_price: number
  original_price: number
  in_stock: boolean
}

interface ListingPage {
  displays: { variant_displays: VariantDisplay[] }[]
  n_hits: number
}

/** The storefront's market ("us", "en-eu") and the Depict merchant id from its script bundle. */
async function storefront(base: string): Promise<{ root: string; market: string; merchant: string }> {
  const html = await fetchText(base)
  // The homepage redirects to the visitor's country version; its canonical link says which.
  const canonical = load(html)('link[rel="canonical"]').attr('href')
  const url = new URL(canonical || base, base)
  const market = url.pathname.split('/').filter(Boolean)[0]
  if (!market) throw new Error('Couldn’t tell which country version of the store to read.')
  const bundle = html.match(/\/static\/js\/main\.[\w.-]+\.js/)?.[0]
  const merchant = bundle && (await fetchText(`${url.origin}${bundle}`, '*/*')).match(/merchant:"([\w-]+)"/)?.[1]
  if (!merchant) throw new Error('Couldn’t find the store’s product listing service.')
  return { root: url.origin, market, merchant }
}

function genderOf(v: VariantDisplay, listing: Gender): Gender {
  const g = (v.gender_display_name ?? []).join(' ')
  if (/unisex/i.test(g)) return 'unisex'
  if (/\bmale\b|\bmen\b/i.test(g)) return 'men'
  if (/female|women/i.test(g)) return 'women'
  return listing
}

function toRaw(root: string, market: string, variants: VariantDisplay[], gender: Gender): RawProduct {
  const v = variants[0]
  const sizes: Size[] = variants
    .map((s) => ({ label: s.size_name ?? s.size ?? '', available: s.in_stock }))
    .filter((s) => s.label && !/^one ?size$/i.test(s.label))
  const type = v.attr_garment_type?.[0] ?? v.product_type_display_name?.[0] ?? ''
  return {
    externalId: v.display_item_id,
    handle: v.uri,
    title: v.title,
    brand: '',
    descriptionHtml: '',
    url: `${root}/${market}/${v.uri}`,
    productType: v.product_type_display_name?.join(' ') ?? '',
    tags: [],
    images: v.image_urls ?? [],
    price: v.sale_price,
    compareAtPrice: v.original_price > v.sale_price ? v.original_price : null,
    currency: null,
    sizes,
    colors: [],
    available: variants.some((s) => s.in_stock),
    collectionGender: genderOf(v, gender),
    storeCategory: collectionCategory('', type) ?? collectionCategory('', v.product_type_display_name?.[0] ?? '')
  }
}

export const depict: Adapter = {
  platform: 'depict',

  async detect(base) {
    try {
      return (await fetchText(base, 'text/html', 0)).includes('INITIAL_DEPICT_CONTEXT')
    } catch {
      return false
    }
  },

  async fetchAll(base, onProgress): Promise<FetchResult> {
    const { root, market, merchant } = await storefront(base)
    const query = `merchant=${merchant}&market=${market}&locale=en_US`
    const listings = await fetchJson<Listing[]>(`${API}/listings?${query}`)
    // The top-level men's, women's and unisex sections hold the whole adult range.
    const sections = listings
      .filter((l) => l.listing_type === 'category' && l.external_id)
      .map((l) => ({ id: l.external_id!, gender: /\bunisex\b/i.test(l.title) ? ('unisex' as const) : collectionGender(l.slug ?? '', l.title) }))
      .filter((l): l is { id: string; gender: 'men' | 'women' | 'unisex' } => !!l.gender)
    if (!sections.length) throw new Error('Couldn’t find the store’s men’s or women’s section.')

    const byId = new Map<string, RawProduct>()
    let complete = true
    for (const section of sections) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await postJson<ListingPage>(`${API}/listings/external_id/${section.id}/products`, {
          merchant,
          market,
          locale: 'en_US',
          hits_per_page: PER_PAGE,
          page,
          // Hides duplicate "secondary" entries, as the store's own pages do.
          filters: [{ field: 'attr_secondary_display', data: ['false'], op: 'in' }]
        })
        for (const d of data.displays) {
          if (!d.variant_displays?.length) continue
          const p = toRaw(root, market, d.variant_displays, section.gender)
          const prev = byId.get(p.externalId)
          // Found in both the men's and women's sections: unisex.
          if (prev && prev.collectionGender !== p.collectionGender) prev.collectionGender = 'unisex'
          else if (!prev) byId.set(p.externalId, p)
        }
        onProgress(byId.size)
        if (page * PER_PAGE >= data.n_hits || !data.displays.length) break
        if (page === MAX_PAGES) complete = false
        await sleep(1000)
      }
    }

    // Listings carry no currency; read it from one product page.
    const products = [...byId.values()]
    let currency: string | null = null
    if (products.length) {
      try {
        currency = parseProduct(products[0].url, await fetchText(products[0].url, 'text/html', 1))?.currency ?? null
      } catch {
        /* falls back to the store's last known currency */
      }
    }
    for (const p of products) p.currency = currency
    return { products, currency, complete, source: `${root}/${market}` }
  }
}
