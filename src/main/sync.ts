import { load } from 'cheerio'
import type { Size, Store, SyncStatus, SyncStoreResult } from '@shared/types'
import { generic } from './adapters/generic'
import { shopify } from './adapters/shopify'
import type { Adapter, RawProduct } from './adapters/types'
import { woocommerce } from './adapters/woocommerce'
import { type NewAlert, wishlistAlerts } from './alerts'
import { brandResolver } from './brands'
import { departmentOf } from '@shared/categories'
import { classifyCategory, classifyGender, isKids } from './classify'
import * as db from './db'
import { mapLimit } from './http'
import { refreshRates } from './currency'
import { detectPromotions } from './promotions'

const ADAPTERS: Adapter[] = [shopify, woocommerce, generic]
const STORE_CONCURRENCY = 3
// Listings that aren't things you'd buy on their own: gift cards, shipping
// add-ons, and lens upgrades that eyewear stores list as separate products.
const NOT_A_PRODUCT = /\b(gift ?cards?|e-?gift|gift ?vouchers?|gift ?certificates?|shipping protection|route package protection|prescription lens(es)?|custom lens(es)?|lens (upgrade|option)s?|blue light filter lens(es)?|rox_lens)\b/i

let status: SyncStatus = { running: false, currentStore: null, completed: 0, total: 0, lastRunAt: null, results: [] }
let listener: (s: SyncStatus) => void = () => {}
let alertListener: (alerts: NewAlert[]) => void = () => {}

export function onStatus(fn: (s: SyncStatus) => void) {
  listener = fn
}

/** Called once per sync run with any new wishlist alerts. */
export function onAlerts(fn: (alerts: NewAlert[]) => void) {
  alertListener = fn
}

export function getStatus(): SyncStatus {
  return status
}

function emit(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch }
  listener(status)
}

export async function detectPlatform(base: string): Promise<Adapter> {
  for (const a of ADAPTERS) if (await a.detect(base)) return a
  return generic
}

export function htmlToText(html: string): string {
  if (!html) return ''
  const $ = load(html)
  $('script, style, iframe').remove()
  $('br').replaceWith('\n')
  $('p, div, li, h1, h2, h3, h4, h5, h6, tr').each((_, el) => {
    $(el).append('\n')
  })
  $('li').each((_, el) => {
    $(el).prepend('• ')
  })
  return $.root()
    .text()
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+• *\n*/g, '\n• ')
    .trim()
}

async function syncStore(store: Store, alerts: NewAlert[]): Promise<SyncStoreResult> {
  const result: SyncStoreResult = { storeId: store.id, storeName: store.name, added: 0, updated: 0, removed: 0, priceDrops: 0, error: null }
  try {
    const adapter = store.platform ? ADAPTERS.find((a) => a.platform === store.platform)! : await detectPlatform(store.url)
    if (!store.platform) db.updateStore(store.id, { platform: adapter.platform })

    const fetched = await adapter.fetchAll(store.url, () => {})
    if (!fetched.products.length) throw new Error('No products found. The store may be empty, or it may block automated access.')
    const existing = db.existingProducts(store.id)
    const liveBefore = [...existing.values()].filter((r) => !r.removed_at).length
    const initial = existing.size === 0
    // A different catalogue (e.g. switching to a store's English/US version) can
    // carry different prices; that's not a markdown, so skip drop detection once.
    const sourceChanged = !!fetched.source && store.source !== fetched.source
    const currency = fetched.currency ?? store.currency ?? 'USD'
    const settings = db.getSettings()
    const favorites = db.favoriteSizes()
    const storeAlerts: NewAlert[] = []

    // Classify everything first so the store's overall mix can inform unlabelled items.
    const products = fetched.products.filter(
      (raw) =>
        !NOT_A_PRODUCT.test(`${raw.productType} ${raw.title}`) &&
        // Children's lines are never collected.
        !raw.kids &&
        !isKids(raw.title, raw.productType, raw.tags.join(' '), urlPath(raw.url))
    )
    const brandOf = brandResolver(store.name, products.map((p) => p.brand))
    const byId = new Map<string, Omit<db.StoredProductInput, 'position'>>()
    for (const raw of products) {
      const id = `${store.id}:${raw.externalId}`
      if (!byId.has(id)) byId.set(id, toStored(store, raw, id, currency, brandOf(raw.brand)))
    }
    // A store whose men's section holds nearly everything (and has no women's
    // section) is signalling that the clothing left outside it is womenswear.
    const rawById = new Map(products.map((r) => [`${store.id}:${r.externalId}`, r]))
    const raws = [...byId.keys()].map((id) => rawById.get(id)!)
    const share = (g: string) => raws.filter((r) => r.collectionGender === g || r.collectionGender === 'unisex').length / Math.max(1, raws.length)
    for (const [inside, outside] of [['men', 'women'], ['women', 'men']] as const) {
      if (share(inside) < 0.85 || share(outside) > 0) continue
      for (const [i, p] of [...byId.values()].entries())
        if (p.gender === 'unknown' && !raws[i].collectionGender && ['Clothing', 'Shoes'].includes(departmentOf(p.category))) p.gender = outside
    }
    const storeGender = inferStoreGender([...byId.values()].map((p) => p.gender))
    if (storeGender) for (const p of byId.values()) if (p.gender === 'unknown') p.gender = storeGender
    db.updateStore(store.id, { gender: storeGender ?? 'mixed' })

    // Only keep the user's department: drop items that belong to the other one.
    const unwanted = settings.gender === 'men' ? 'women' : settings.gender === 'women' ? 'men' : null
    const wanted = [...byId.values()].filter((p) => p.gender !== unwanted)
    const seen = new Set<string>()

    db.transaction(() => {
      for (const stored of wanted) {
        const id = stored.id
        seen.add(id)
        const prev = existing.get(id)
        const next = { ...stored, position: seen.size }
        const { priceDropped } = db.upsertProduct(next, initial, prev, sourceChanged)
        // Restocks are judged against the size saved with the item, else the user's sizes.
        if (prev && favorites.has(id)) {
          const size = favorites.get(id)
          storeAlerts.push(...wishlistAlerts(prev, next, size ? [size] : settings.mySizes, db.formatPrice))
        }
        if (!prev) result.added++
        else result.updated++
        if (priceDropped) result.priceDrops++
      }

      // Only retire products when we trust the fetch was complete; a partial
      // response (rate limit, outage) shouldn't wipe out the catalogue. A
      // department change legitimately shrinks it, so skip the check then.
      const scopeChanged = store.scope !== settings.gender
      const plausible = scopeChanged || seen.size >= liveBefore * 0.5
      if (fetched.complete && plausible) {
        const gone = [...existing.entries()].filter(([id, r]) => !seen.has(id) && !r.removed_at).map(([id]) => id)
        db.markRemoved(gone)
        result.removed = gone.length
      }
      db.insertAlerts(storeAlerts)
    })
    alerts.push(...storeAlerts)

    try {
      db.replaceDetectedPromotions(store.id, await detectPromotions(store.url))
    } catch {
      /* homepage unreachable: keep previous promotions */
    }
    db.updateStore(store.id, { lastSyncedAt: new Date().toISOString(), lastError: null, currency, scope: settings.gender, source: fetched.source ?? null })
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    db.updateStore(store.id, { lastError: result.error })
  }
  return result
}

/**
 * A store whose labelled items are overwhelmingly one gender (a menswear
 * brand, say) is treated as that gender for items it doesn't label.
 */
function inferStoreGender(genders: string[]): 'men' | 'women' | null {
  const men = genders.filter((g) => g === 'men').length
  const women = genders.filter((g) => g === 'women').length
  const labelled = men + women
  if (labelled < 5) return null
  if (men / labelled >= 0.9) return 'men'
  if (women / labelled >= 0.9) return 'women'
  return null
}

const urlPath = (url: string) => {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

// Separators stores put between a model and its colour: "Slip On – Black", "Cord Trousers #Olive".
const COLOUR_SUFFIX = /^(.*?\S)\s*(?:#\s*|\s[–—-]\s+)([^–—#]{1,32})$/

/** Splits "Staples Slip On – Black" into the model ("staples slip on") and colour ("Black"). */
export function modelOf(title: string): { base: string; colour: string | null } {
  const t = title.replace(/\s+/g, ' ').trim()
  const m = t.match(COLOUR_SUFFIX)
  const base = (m ? m[1] : t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return { base, colour: m ? m[2].trim() : null }
}

/** Folds "54-17RX"-style prescription duplicates into the plain size. */
function foldRxSizes(sizes: Size[]): Size[] {
  const out = new Map<string, boolean>()
  for (const s of sizes) {
    const label = s.label.replace(/\s*[-/]?\s*RX$/i, '').trim()
    if (label) out.set(label, (out.get(label) ?? false) || s.available)
  }
  return [...out].map(([label, available]) => ({ label, available }))
}

function toStored(store: Store, raw: RawProduct, id: string, currency: string, brand: string): Omit<db.StoredProductInput, 'position'> {
  const category = classifyCategory(raw.productType, raw.title, raw.tags, [urlPath(raw.url), ...(raw.colors ?? []).map((c) => c.name)].join(' '))
  const gender = classifyGender({ productType: raw.productType, title: raw.title, tags: raw.tags, url: raw.url }, category, raw.collectionGender)
  const { base, colour } = modelOf(raw.title)
  return {
    id,
    storeId: store.id,
    externalId: raw.externalId,
    title: raw.title,
    brand,
    description: htmlToText(raw.descriptionHtml),
    url: raw.url,
    productType: raw.productType,
    tags: raw.tags,
    category,
    gender,
    images: raw.images,
    price: raw.price,
    compareAtPrice: raw.compareAtPrice,
    currency: raw.currency ?? currency,
    sizes: foldRxSizes(raw.sizes),
    colors: raw.colors ?? [],
    modelKey: `${store.id}|${category}|${gender}|${base}`,
    colorLabel: colour,
    available: raw.available
  }
}

// Requests made while a sync is running are queued; null means "all stores".
let queued: Set<number> | null | undefined

export async function runSync(storeId?: number): Promise<void> {
  if (status.running) {
    if (storeId == null) queued = null
    else if (queued !== null) (queued ??= new Set()).add(storeId)
    return
  }
  const stores = db.listStores().filter((s) => s.enabled && (storeId == null || s.id === storeId))
  if (!stores.length) return
  emit({ running: true, completed: 0, total: stores.length, currentStore: stores[0].name, results: [] })
  await refreshRates()
  const results: SyncStoreResult[] = []
  const alerts: NewAlert[] = []
  await mapLimit(stores, STORE_CONCURRENCY, async (store) => {
    emit({ currentStore: store.name })
    results.push(await syncStore(store, alerts))
    emit({ completed: results.length, results: [...results] })
  })
  db.purgeOldRemoved()
  emit({ running: false, currentStore: null, lastRunAt: new Date().toISOString() })
  if (alerts.length) alertListener(alerts)

  const next = queued
  queued = undefined
  if (next === null) await runSync()
  else if (next) for (const id of next) await runSync(id)
}
