import { load, type CheerioAPI } from 'cheerio'
import type { Colorway, Gender, Size } from '@shared/types'
import { collectionCategory, collectionGender } from '../classify'
import { fetchText } from '../http'
import { type ItemDetail, pacer, readPrices, wanted, withDetails } from './gentle'
import type { Adapter, FetchResult, RawProduct } from './types'

// Ebisumart, a Japanese shop system (Kapital's web shop). It has no product
// feed or sitemap, and these shops block fast crawling, so it's read gently
// (see gentle.ts): each sync reads the category listings, which carry each
// piece's name, price and photo; product pages, which hold colours, sizes,
// stock, material and measurements, are read a few at a time and remembered.
//
//   /                               menu: department headings (MEN'S, WOMEN'S,
//                                   ACCESSORY) over categories ("Jacket(55)")
//   /category/M_JACKET/?…           category listing, up to 100 per page
//   /category/M_JACKET/EK1117LJ.html  product page, with a stock matrix

const PER_PAGE = 100
const MAX_PAGES = 20

interface Category {
  code: string
  label: string
  gender: Gender | null
}

/** The categories in the shop's menu, under their department headings, leaving out "… All" roll-ups. */
export function categories(html: string): Category[] {
  const $ = load(html)
  const found = new Map<string, Category & { heading: string; all: boolean }>()
  $('a[href*="/category/"]').each((_, a) => {
    const code = ($(a).attr('href') ?? '').match(/\/category\/([^/?#]+)\/?$/)?.[1]
    const text = $(a).text().replace(/\s+/g, ' ').trim()
    // Real categories show their size ("Jacket(55)"); department headings don't.
    const count = text.match(/\((\d+)\)$/)
    if (!code || !count || found.has(code) || count[1] === '0') return
    const label = text.replace(/\(\d+\)$/, '').trim()
    const heading =
      $(a)
        .parents('li')
        .slice(1)
        .map((_, li) => {
          const own = $(li).clone()
          own.find('ul').remove()
          return own.text().replace(/\s+/g, ' ').trim()
        })
        .get()
        .find(Boolean) ?? ''
    // Gender from the category's own name, the department it's under, or the
    // common M_/W_ code prefix.
    const gender =
      collectionGender(code.replace(/_/g, ' '), label) ??
      collectionGender('', heading) ??
      (/^M_/i.test(code) ? 'men' : /^W_/i.test(code) ? 'women' : null)
    found.set(code, { code, label, gender, heading, all: /\ball\b|すべて|全て/i.test(label) })
  })
  // A department's "All" category repeats its others; it's only read when it's all there is.
  const cats = [...found.values()]
  return cats
    .filter((c) => !c.all || !cats.some((o) => !o.all && o.heading === c.heading))
    .map(({ code, label, gender }) => ({ code, label, gender }))
}

/** Pieces in one page of a category listing. */
export function listing(base: string, html: string, cat: Category): { items: RawProduct[]; total: number } {
  const $ = load(html.replace(/<!--[\s\S]*?-->/g, ''))
  const items: RawProduct[] = []
  $('.item_list_box, li:has(.item_name)').each((_, box) => {
    const link = $(box).find('.item_name a').first()
    const href = link.attr('href') ?? ''
    const code = href.match(/\/([A-Za-z0-9_-]+)\.html$/)?.[1]
    if (!code || items.some((i) => i.externalId === code)) return
    const { amounts } = readPrices($(box).find('.item_price').first().text())
    const img = $(box).find('img').first().attr('src')
    items.push({
      externalId: code,
      handle: code.toLowerCase(),
      title: link.text().trim(),
      brand: '',
      descriptionHtml: '',
      url: new URL(href, base).toString(),
      productType: cat.label,
      tags: [cat.code],
      images: img ? [new URL(img, base).toString()] : [],
      price: amounts[0] ?? 0,
      compareAtPrice: null,
      currency: 'JPY',
      sizes: [],
      colors: [],
      available: true,
      collectionGender: cat.gender,
      storeCategory: collectionCategory(cat.code.replace(/^[MW]_/i, '').replace(/_/g, '-'), cat.label)
    })
  })
  const total = Number($('.pageguide').first().text().match(/全\s*([\d,]+)\s*件/)?.[1]?.replace(/,/g, '') ?? items.length)
  return { items, total }
}

// Measurement names in size tables, so the size guide reads in English.
const MEASURE_NAMES: [RegExp, string][] = [
  [/^サイズ$/, 'Size'],
  [/^着丈$/, 'Length'],
  [/^総丈$/, 'Total length'],
  [/^肩幅$/, 'Shoulder'],
  [/^胸囲$/, 'Chest'],
  [/^身幅$/, 'Body width'],
  [/^裄丈$/, 'Sleeve (from neck)'],
  [/^袖丈$/, 'Sleeve'],
  [/^袖口$/, 'Cuff'],
  [/^袖幅$/, 'Sleeve width'],
  [/^首ぐり$/, 'Neck'],
  [/^裾(幅|周り)?$/, 'Hem'],
  [/^ウエスト$/, 'Waist'],
  [/^ヒップ$/, 'Hip'],
  [/^股上$/, 'Rise'],
  [/^股下$/, 'Inseam'],
  [/^(ワタリ|わたり)(幅)?$/, 'Thigh'],
  [/^高さ$/, 'Height'],
  [/^幅$/, 'Width'],
  [/^マチ$/, 'Depth'],
  [/^頭周り$/, 'Head'],
  [/^ツバ$/, 'Brim'],
  [/^重さ$/, 'Weight']
]

function englishHeadings($: CheerioAPI) {
  $('td, th').each((_, cell) => {
    const t = $(cell).text().trim()
    const hit = MEASURE_NAMES.find(([re]) => re.test(t))
    if (hit) $(cell).text(hit[1])
  })
}

/** Colours, sizes, stock, photos and description from a product page. */
export function detail(base: string, code: string, html: string): ItemDetail | null {
  const $ = load(html.replace(/<!--[\s\S]*?-->/g, ''))
  if (!$('.item_property, #itemName').length) return null

  // The option menus: colour (カラー) and size (サイズ), by their labels.
  const options = (label: RegExp) =>
    $('.item_property .property')
      .filter((_, el) => label.test($(el).clone().children().remove().end().text()))
      .find('select option')
      .toArray()
      .map((o) => ({ value: $(o).attr('value') ?? '', name: $(o).text().trim() }))
      .filter((o) => o.value)
  const colourOptions = options(/カラー|colou?r/i)
  const sizeOptions = options(/サイズ|size/i)

  // Stock matrix: a column per size, a row per colour, the count in stock.
  const stock: { size: string; colour: string; n: number }[] = []
  $('#products_matrix_nyuka .propertyCols').each((_, col) => {
    const size = $(col).find('.colName').first().text().trim()
    $(col)
      .find('.matrix_row_nyuka')
      .each((_, row) => {
        stock.push({ size, colour: $(row).find('.rowName').text().trim(), n: Number($(row).find('.itemproperty_zaiko').text().trim()) || 0 })
      })
  })
  // One variation only: the rows are its values.
  if (!stock.length)
    $('.matrix_row_nyuka').each((_, row) => {
      const name = $(row).find('.rowName').text().trim()
      const n = Number($(row).find('.itemproperty_zaiko').text().trim()) || 0
      stock.push(sizeOptions.length ? { size: name, colour: '', n } : { size: '', colour: name, n })
    })
  const inStock = (colour: string | null, size: string | null) =>
    !stock.length || stock.some((s) => s.n > 0 && (!colour || !s.colour || s.colour === colour) && (!size || !s.size || s.size === size))

  const photos = [
    ...new Set(
      $(`img[src*="/itemimage/${code}/"], a[href*="/itemimage/${code}/"]`)
        .toArray()
        .map((el) => $(el).attr('src') ?? $(el).attr('href') ?? '')
        .filter((src) => /\.(jpe?g|png|webp)$/i.test(src.split('?')[0]))
        .map((src) => new URL(src, base).toString())
    )
  ]
  // Photos are named with the colour's code ("EK1599LSA_2026SS2_BGR.jpg").
  const photoOf = (value: string) => photos.find((p) => new RegExp(`_${value}\\.(jpe?g|png|webp)$`, 'i').test(p.split('?')[0])) ?? null
  const colors: Colorway[] = colourOptions.map((c) => {
    const photo = photoOf(c.value)
    return { name: c.name, available: inStock(c.name, null), image: photo, images: photo ? [photo] : [] }
  })
  const sizes: Size[] = sizeOptions.map((s) => ({ label: s.name, available: inStock(null, s.name) }))

  // Description and material, then the measurements table.
  const description = $('.explanation1').first()
  const measurements = $('.explanation2').first()
  englishHeadings($)
  const descriptionHtml = [description.html() ?? '', measurements.html() ?? ''].join('')

  return {
    sizes,
    colors: colors.length > 1 ? colors : [],
    images: photos,
    descriptionHtml,
    available: !stock.length || stock.some((s) => s.n > 0)
  }
}

export const ebisumart: Adapter = {
  platform: 'ebisumart',

  async detect(base) {
    try {
      const html = await fetchText(base)
      return /\/client_info\/[^/"]+\//.test(html) && /\/category\/[^/"]+\/"/.test(html)
    } catch {
      return false
    }
  },

  async fetchAll(base, onProgress): Promise<FetchResult> {
    const get = pacer()
    const cats = categories(await get(base)).filter((c) => wanted(c.gender))
    if (!cats.length) throw new Error('Couldn’t find the shop’s categories.')
    const byId = new Map<string, RawProduct>()
    let complete = true
    for (const cat of cats) {
      let seen = 0
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${base}/category/${cat.code}/?SEARCH_MAX_ROW_LIST=${PER_PAGE}&item_list_mode=2&sort_order=1&request=page&next_page=${page}`
        const { items, total } = listing(base, await get(url), cat)
        // A piece in several categories keeps the first (menu order runs specific to general).
        for (const item of items) if (!byId.has(item.externalId)) byId.set(item.externalId, item)
        seen += items.length
        onProgress(byId.size)
        if (!items.length || seen >= total) break
        if (page === MAX_PAGES) complete = false
      }
    }
    const products = await withDetails(new URL(base).host, [...byId.values()], async (item) =>
      detail(base, item.externalId, await get(item.url))
    )
    return { products, currency: 'JPY', complete }
  }
}
