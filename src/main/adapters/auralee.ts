import { load } from 'cheerio'
import type { Colorway, Gender, Size } from '@shared/types'
import { collectionGender } from '../classify'
import { type ItemDetail, pacer, readPrices, wanted, withDetails } from './gentle'
import type { Adapter, FetchResult, RawProduct } from './types'

// Auralee's own shop is a custom site with no sitemap or product feed.
//
//   /item?category_id=3             men's listing, 32 per page, "VIEW MORE" links onward
//   /item/detail/1_1_CODE_1/COLOUR  product page; `var item_stock = {...}` holds
//                                   every colour with stock per size
//
// Listing prices are shown in the visitor's currency, duties included.
const HOST = /(^|\.)auralee\.jp$/i
const MAX_PAGES = 30

interface Section {
  url: string
  gender: Gender | null
}

export function sections(base: string, html: string): Section[] {
  const $ = load(html)
  const found = new Map<string, Section>()
  $('a[href*="/item?category_id="][data-category]').each((_, a) => {
    const url = new URL($(a).attr('href')!, base).toString()
    const gender = collectionGender($(a).attr('data-category') ?? '', $(a).text())
    if (gender && !found.has(url)) found.set(url, { url, gender })
  })
  return [...found.values()]
}

export function listing(base: string, html: string, gender: Gender | null): { items: RawProduct[]; next: string | null } {
  const $ = load(html)
  const items: RawProduct[] = []
  $('.goodsTile').each((_, tile) => {
    const t = $(tile)
    const code = t.find('[data-ga_ec_goods_id]').attr('data-ga_ec_goods_id')
    const link = t.find('a.item__name')
    const href = link.attr('href')
    const { amounts, currency } = readPrices(t.find('.price').text())
    if (!code || !href || !amounts.length) return
    const img = t.find('img.default').attr('src') ?? t.find('img').first().attr('src')
    items.push({
      externalId: code,
      handle: code.toLowerCase(),
      title: link.text().trim(),
      brand: 'AURALEE',
      descriptionHtml: '',
      url: new URL(href, base).toString(),
      productType: '',
      tags: [],
      images: img ? [new URL(img, base).toString()] : [],
      price: Math.min(...amounts),
      compareAtPrice: amounts.length > 1 && Math.max(...amounts) > Math.min(...amounts) ? Math.max(...amounts) : null,
      currency,
      sizes: [],
      colors: [],
      available: true,
      collectionGender: gender
    })
  })
  const next = $('a.view_more').attr('href')
  return { items, next: next ? new URL(next, base).toString() : null }
}

interface StockColour {
  color_name: string
  color_swatch?: string
  images?: string
  stock: string | number
  sizes: { size_name: string; stock: string | number }[]
}

export function detail(base: string, html: string): ItemDetail | null {
  const raw = html.match(/var item_stock = (\{[\s\S]*?\});\s*\n/)?.[1]
  if (!raw) return null
  // A JavaScript literal: tolerate trailing commas.
  const colours = (JSON.parse(raw.replace(/,\s*([\]}])/g, '$1')) as { colors: StockColour[] }).colors ?? []
  const $ = load(html)

  // The page's JSON-LD has raw line breaks in its description, so it isn't valid
  // JSON; take the photo list out of it directly.
  const ld = $('script[type="application/ld+json"]').text()
  const photos = [...(ld.match(/"image"\s*:\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1])

  const photoOf = (c: StockColour) => {
    const src = c.images?.match(/src=["']?([^"'\s>]+)/)?.[1] ?? new URLSearchParams(c.color_swatch?.split('?')[1] ?? '').get('file_name')
    return src ? new URL(src, base).toString() : null
  }
  const colors: Colorway[] = colours.map((c) => ({ name: c.color_name, available: Number(c.stock) > 0, image: photoOf(c) }))

  const bySize = new Map<string, boolean>()
  for (const c of colours) for (const s of c.sizes ?? []) bySize.set(s.size_name, (bySize.get(s.size_name) ?? false) || Number(s.stock) > 0)
  const sizes: Size[] = [...bySize].map(([label, available]) => ({ label, available })).filter((s) => !/^(one ?size|free|f)$/i.test(s.label))

  return {
    sizes,
    colors: colors.length > 1 ? colors : [],
    images: photos.map((p) => new URL(p, base).toString()),
    descriptionHtml: $('#tab--description .tab-block__txt').first().html()?.trim() ?? '',
    available: colours.some((c) => Number(c.stock) > 0)
  }
}

export const auralee: Adapter = {
  platform: 'auralee',

  async detect(base) {
    return HOST.test(new URL(base).hostname)
  },

  async fetchAll(base, onProgress): Promise<FetchResult> {
    const get = pacer()
    const found = sections(base, await get(base))
    if (!found.length) throw new Error('Couldn’t find the men’s or women’s section.')
    const byId = new Map<string, RawProduct>()
    let complete = true
    for (const section of found.filter((s) => wanted(s.gender))) {
      let url: string | null = section.url
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const { items, next } = listing(base, await get(url), section.gender)
        for (const item of items) if (!byId.has(item.externalId)) byId.set(item.externalId, item)
        onProgress(byId.size)
        url = next
      }
      if (url) complete = false
    }
    const products = await withDetails(new URL(base).host, [...byId.values()], async (item) => detail(base, await get(item.url)))
    return { products, currency: products[0]?.currency ?? null, complete }
  }
}
