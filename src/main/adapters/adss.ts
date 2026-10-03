import { fetchJson, sleep, tryFetchJson } from '../http'
import type { Adapter, FetchResult, RawProduct } from './types'

// ADSS, a Japanese shop system (Kaptain Sunshine). Its listing pages fill
// themselves from a public product search, /ise/select (Solr, JSON), which
// returns every product with prices, colours, sizes, material and per-size
// measurements. One request reads up to PER_PAGE products.

interface AdssDoc {
  cd: string
  bd: string
  ml?: string
  name: string
  bdName?: string
  price: number
  basicPrice?: number
  mainImg?: string
  subImg?: string[]
  vcbName?: string[]
  vcbImg?: string[]
  vcaName?: string[]
  material?: string[]
  copy?: string
  cn1?: string[]
  cn3?: string[]
  kw?: string[]
  stnum?: number
  [measure: string]: unknown
}

const PER_PAGE = 200
const MAX_PAGES = 20
const QUERY = 'wt=json&fq=scls%3An_*&fq=-scls:n_out&sort=rk%20desc%2Cfsdt%20desc'

// Measurement fields (one value per size), in the order a size guide reads.
const MEASURES: [string, string][] = [
  ['shoulderWidth', 'Shoulder'],
  ['kyoui', 'Chest'],
  ['mihaba', 'Body width'],
  ['kiTake', 'Length'],
  ['sodeTake', 'Sleeve'],
  ['yukiTake', 'Sleeve (from neck)'],
  ['waistSize', 'Waist'],
  ['hipSize', 'Hip'],
  ['matagami', 'Rise'],
  ['matashita', 'Inseam'],
  ['watari', 'Thigh'],
  ['susohaba', 'Hem'],
  ['allLength', 'Total length'],
  ['tate', 'Height'],
  ['height', 'Height'],
  ['yoko', 'Width'],
  ['width', 'Width'],
  ['machi', 'Depth'],
  ['wrist', 'Wrist']
]

/** "SHELL：Wool70% Cotton30% SLEEVE LINING：Cupra50% Cotton50%" → "Shell: Wool 70%, Cotton 30%; Sleeve lining: Cupra 50%, Cotton 50%". */
function tidyMaterial(m: string): string {
  return m
    .replace(/：/g, ':')
    .split(/(?<=[^A-Z\s])\s+(?=[A-Z][A-Z ]*:)/)
    .map((part) => {
      const [label, value] = part.includes(':') ? part.split(/:\s*/, 2) : ['', part]
      const fibres = value
        .replace(/([A-Za-z])(\d)/g, '$1 $2')
        .trim()
        .split(/(?<=%)\s+/)
        .join(', ')
      return label ? `${label.charAt(0)}${label.slice(1).toLowerCase()}: ${fibres}` : fibres
    })
    .filter(Boolean)
    .join('; ')
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The store's material, care notes and measurements as description HTML (see details.ts). */
function descriptionOf(d: AdssDoc): string {
  const parts: string[] = []
  for (const m of d.material ?? []) parts.push(`<p>Composition: ${escape(tidyMaterial(m))}</p>`)
  const sizes = d.vcaName ?? []
  const rows = MEASURES.map(([key, label]) => [label, d[key]] as const).filter(
    (r): r is readonly [string, string[]] => Array.isArray(r[1]) && r[1].length === sizes.length && sizes.length > 0
  )
  if (rows.length) {
    parts.push(
      `<table><tr><td>Measurements:</td>${sizes.map((s) => `<td>${escape(s)}</td>`).join('')}</tr>${rows
        .map(([label, vals]) => `<tr><td>${label}</td>${vals.map((v) => `<td>${escape(String(v))}</td>`).join('')}</tr>`)
        .join('')}</table>`
    )
  }
  if (d.copy) parts.push(`<p>Care: ${d.copy.split(/<br\s*\/?>/i).map(escape).join(', ').toLowerCase()}</p>`)
  return parts.join('')
}

function toRaw(base: string, d: AdssDoc): RawProduct {
  const img = (file: string) => `https://itemimg-${(d.ml ?? 'kps').toLowerCase()}.adss-sys.com/itemimg/${d.bd}/${d.cd}/${file}`
  const available = (d.stnum ?? 0) > 0
  const colourNames = d.vcbName ?? []
  const colors =
    colourNames.length > 1
      ? colourNames.map((name, i) => {
          const image = d.vcbImg?.[i] ? img(d.vcbImg[i]) : null
          return { name, available, image, images: image ? [image] : [] }
        })
      : []
  return {
    externalId: d.cd,
    handle: d.cd,
    title: d.name,
    brand: d.bdName ?? '',
    descriptionHtml: descriptionOf(d),
    url: `${base}/ap/item/i/${d.cd}`,
    // "CUTSEW" is the Japanese trade word for jersey tops.
    productType: [d.cn1?.[0], d.cn3?.[0]].filter(Boolean).join(' ').replace(/\bCUTSEW\b/gi, 'TOPS'),
    tags: [],
    images: [d.mainImg, ...(d.subImg ?? []), ...(d.vcbImg ?? [])].filter((f): f is string => !!f).map(img),
    price: d.price,
    compareAtPrice: d.basicPrice && d.basicPrice > d.price ? d.basicPrice : null,
    currency: 'JPY',
    // The search gives stock for the product as a whole, so sizes share it.
    sizes: (d.vcaName ?? []).map((label) => ({ label, available })),
    colors,
    colour: colourNames.length === 1 ? colourNames[0] : null,
    available,
    collectionGender: null
  }
}

export const adss: Adapter = {
  platform: 'adss',

  async detect(base) {
    const data = await tryFetchJson<{ response?: { numFound?: number } }>(`${base}/ise/select?wt=json&rows=0`)
    return typeof data?.response?.numFound === 'number'
  },

  async fetchAll(base, onProgress): Promise<FetchResult> {
    const docs: AdssDoc[] = []
    let complete = false
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await fetchJson<{ response: { numFound: number; docs: AdssDoc[] } }>(
        `${base}/ise/select?${QUERY}&start=${page * PER_PAGE}&rows=${PER_PAGE}`
      )
      docs.push(...data.response.docs)
      onProgress(docs.length)
      if (docs.length >= data.response.numFound || !data.response.docs.length) {
        complete = true
        break
      }
      await sleep(1000)
    }
    return { products: docs.map((d) => toRaw(base, d)), currency: 'JPY', complete }
  }
}
