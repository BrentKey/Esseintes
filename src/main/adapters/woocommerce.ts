import type { Gender } from '@shared/types'
import { collectionGender, isSizeOption } from '../classify'
import { fetchJson, sleep, tryFetchJson } from '../http'
import type { Adapter, FetchResult, RawProduct } from './types'

interface WooProduct {
  id: number
  name: string
  slug: string
  permalink: string
  description: string
  short_description: string
  prices: {
    price: string
    regular_price: string
    sale_price: string
    currency_code: string
    currency_minor_unit: number
  }
  images: { src: string }[]
  categories: { name: string }[]
  tags: { name: string }[]
  brands?: { name: string }[]
  attributes: { name: string; terms: { name: string }[] }[]
  is_in_stock: boolean
}

const PER_PAGE = 100
const MAX_PAGES = 200
const API = '/wp-json/wc/store/v1/products'

function money(value: string, minor: number): number {
  return parseInt(value || '0', 10) / 10 ** (minor ?? 2)
}

function toRaw(p: WooProduct): RawProduct {
  const minor = p.prices?.currency_minor_unit ?? 2
  const price = money(p.prices?.price, minor)
  const regular = money(p.prices?.regular_price, minor)
  const sizeAttr = (p.attributes ?? []).find((a) => isSizeOption(a.name))
  // Categories like "Men" / "Womens Knitwear" act as the store's gender sections.
  const genders = new Set((p.categories ?? []).map((c) => collectionGender('', decode(c.name))).filter(Boolean))
  const gender: Gender | null = genders.size === 2 ? 'unisex' : genders.size === 1 ? ([...genders][0] as Gender) : null
  return {
    externalId: String(p.id),
    handle: p.slug,
    title: decode(p.name),
    brand: p.brands?.[0]?.name ?? '',
    descriptionHtml: p.description || p.short_description || '',
    url: p.permalink,
    productType: (p.categories ?? []).map((c) => decode(c.name)).join(', '),
    tags: (p.tags ?? []).map((t) => decode(t.name)),
    images: (p.images ?? []).map((i) => i.src),
    price,
    compareAtPrice: regular > price ? regular : null,
    currency: p.prices?.currency_code ?? null,
    // The list endpoint doesn't expose per-variation stock, so sizes share the product's.
    sizes: (sizeAttr?.terms ?? []).map((t) => ({ label: decode(t.name), available: p.is_in_stock })),
    colors: ((p.attributes ?? []).find((a) => a !== sizeAttr && /colou?r|frame|lens|finish/i.test(a.name))?.terms ?? [])
      .map((t) => ({ name: decode(t.name), available: p.is_in_stock, image: null }))
      .filter((_, __, all) => all.length > 1),
    colour: (() => {
      const terms = (p.attributes ?? []).find((a) => a !== sizeAttr && /colou?r/i.test(a.name))?.terms ?? []
      return terms.length === 1 ? decode(terms[0].name) : null
    })(),
    available: p.is_in_stock,
    collectionGender: gender
  }
}

function decode(s: string): string {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&#8217;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/&#8211;/g, '–')
}

export const woocommerce: Adapter = {
  platform: 'woocommerce',

  async detect(base) {
    const data = await tryFetchJson<unknown>(`${base}${API}?per_page=1`)
    return Array.isArray(data)
  },

  async fetchAll(base, onProgress): Promise<FetchResult> {
    const all: WooProduct[] = []
    let complete = false
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await fetchJson<WooProduct[]>(`${base}${API}?per_page=${PER_PAGE}&page=${page}`)
      all.push(...batch)
      onProgress(all.length)
      if (batch.length < PER_PAGE) {
        complete = true
        break
      }
      await sleep(350)
    }
    const products = all.map(toRaw)
    return { products, currency: products[0]?.currency ?? null, complete }
  }
}
