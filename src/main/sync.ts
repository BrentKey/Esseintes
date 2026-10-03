import { load } from 'cheerio'
import type { Gender, Size, Store, SyncStatus, SyncStoreResult } from '@shared/types'
import { auralee } from './adapters/auralee'
import { pageReading, takePendingReads } from './adapters/gentle'
import { depict } from './adapters/depict'
import { generic } from './adapters/generic'
import { shopify } from './adapters/shopify'
import type { Adapter, RawProduct } from './adapters/types'
import { woocommerce } from './adapters/woocommerce'
import { type NewAlert, wishlistAlerts } from './alerts'
import { brandResolver } from './brands'
import { classifyCategory, classifyGender, isKids } from './classify'
import * as db from './db'
import { PROFILE_VERSION, profileStore } from './profile'
import { mapLimit } from './http'
import { refreshRates } from './currency'
import { detectPromotions } from './promotions'

const ADAPTERS: Adapter[] = [auralee, shopify, woocommerce, depict, generic]
// Different stores are read side by side; each store's own pace is unchanged.
const STORE_CONCURRENCY = 5
const PAGE_READ_CONCURRENCY = 3
// Listings that aren't things you'd buy on their own: gift cards, shipping
// add-ons, and lens upgrades that eyewear stores list as separate products.
// Listings that aren't for sale at all: lookbook pages ("Resort 21 Look 8", typed
// "Lookbook") and placeholders priced at something like $9,999,999,999.
const LOOKBOOK = /\blook ?books?/i
const LOOK_TITLE = /^(\S+\s+){0,4}look \d+$/i
const PLACEHOLDER_PRICE = 10_000_000
const notForSale = (raw: RawProduct) =>
  raw.price >= PLACEHOLDER_PRICE || LOOKBOOK.test(raw.productType) || LOOK_TITLE.test(raw.title.trim())
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

async function syncStore(store: Store, alerts: NewAlert[], pages: 'defer' | 'cached' = 'defer'): Promise<SyncStoreResult> {
  const result: SyncStoreResult = { storeId: store.id, storeName: store.name, added: 0, updated: 0, removed: 0, priceDrops: 0, error: null }
  try {
    // Stores on the generic fallback are re-checked, so they move to a dedicated reader once one exists.
    const known = store.platform && store.platform !== 'generic' ? ADAPTERS.find((a) => a.platform === store.platform) : undefined
    const adapter = known ?? (await detectPlatform(store.url))
    if (adapter.platform !== store.platform) db.updateStore(store.id, { platform: adapter.platform })

    const fetched = await pageReading.run({ mode: pages, storeId: store.id }, () => adapter.fetchAll(store.url, () => {}))
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
    const forSale = fetched.products.filter((raw) => !notForSale(raw))
    const products = forSale.filter(
      (raw) =>
        !NOT_A_PRODUCT.test(`${raw.productType} ${raw.title}`) &&
        // Listings without a single photo are placeholders or spare parts.
        raw.images.length > 0 &&
        // Children's lines are never collected.
        !raw.kids &&
        !isKids(raw.title, raw.productType, raw.tags.join(' '), urlPath(raw.url))
    )
    // A store moved to another reader may identify products differently; the same
    // web address is the same product, so it keeps its history and saved state.
    const byUrl = new Map([...existing.values()].map((r) => [r.url as string, r.external_id as string]))
    for (const raw of products) {
      if (existing.has(`${store.id}:${raw.externalId}`)) continue
      const known = byUrl.get(raw.url)
      if (known) raw.externalId = known
    }
    const brandOf = brandResolver(store.name, products.map((p) => p.brand))
    const byId = new Map<string, Omit<db.StoredProductInput, 'position'>>()
    for (const raw of products) {
      const id = `${store.id}:${raw.externalId}`
      if (!byId.has(id)) byId.set(id, toStored(store, raw, id, currency, brandOf(raw.brand)))
    }
    // The store's own structure settles what the products' words leave open (see profile.ts).
    const rawById = new Map(products.map((r) => [`${store.id}:${r.externalId}`, r]))
    const items = [...byId.entries()].map(([id, p]) => ({ p, gender: p.gender as Gender, category: p.category, section: rawById.get(id)!.collectionGender, title: p.title, model: pieceOf(p.title) }))
    const profile = profileStore(items, fetched.products.length - forSale.length)
    for (const i of items) i.p.gender = i.gender
    const storeGender = profile.storeGender
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
      // New gender rules (a changed profile version) can too.
      const scopeChanged = store.scope !== settings.gender || store.profile?.version !== PROFILE_VERSION
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
    db.updateStore(store.id, { lastSyncedAt: new Date().toISOString(), lastError: null, currency, scope: settings.gender, source: fetched.source ?? null, profile })
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    db.updateStore(store.id, { lastError: result.error })
  }
  return result
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

/**
 * The piece a title names when the title also names a colour: "Rhein Pant in
 * Black Nappa Leather" and "Solid Track Pant - Midnight" give "rhein pant" and
 * "solid track pant". Titles without a colour give '' (they aren't colourways).
 */
function pieceOf(title: string): string {
  const { base, colour } = modelOf(title)
  if (colour) return base
  const m = base.match(/^(\S+ \S+(?: \S+)*?) in \S/)
  return m ? m[1] : ''
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
  const description = htmlToText(raw.descriptionHtml)
  const category = classifyCategory(
    raw.productType,
    raw.title,
    raw.tags,
    [urlPath(raw.url), ...(raw.colors ?? []).map((c) => c.name)].join(' '),
    raw.storeCategory ?? null,
    description
  )
  const gender = classifyGender(
    { productType: raw.productType, title: raw.title, tags: raw.tags, url: raw.url, description },
    category,
    raw.collectionGender
  )
  const { base, colour } = modelOf(raw.title)
  return {
    id,
    storeId: store.id,
    externalId: raw.externalId,
    title: raw.title,
    brand,
    description,
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

/**
 * At launch, reads only stores not updated within the refresh interval (a store
 * whose last read failed counts as stale). With automatic refresh off, reads all.
 */
export async function runStaleSync(): Promise<void> {
  const hours = db.getSettings().refreshHours
  const stores = db.listStores().filter((s) => s.enabled)
  const cutoff = Date.now() - hours * 3_600_000
  const stale = stores.filter((s) => hours <= 0 || !s.lastSyncedAt || new Date(s.lastSyncedAt).getTime() < cutoff)
  if (stale.length === stores.length) return runSync()
  // Show when the stores were last read, even though nothing is read now.
  const latest = stores.map((s) => s.lastSyncedAt).filter((t): t is string => !!t).sort().pop() ?? null
  emit({ lastRunAt: latest })
  if (stale.length) await runSync(undefined, new Set(stale.map((s) => s.id)))
}

/**
 * Reads one store, the given set of stores, or (with neither) every enabled store.
 * Catalogues come first; slow product-page reading (photos, sizes at shops that
 * only show them on product pages) runs afterwards, then the stores it touched
 * are quickly re-read so the new details show. `pages: 'cached'` is that re-read.
 */
export async function runSync(storeId?: number, only?: Set<number>, pages: 'defer' | 'cached' = 'defer'): Promise<void> {
  if (status.running) {
    if (storeId == null) queued = null
    else if (queued !== null) (queued ??= new Set()).add(storeId)
    return
  }
  const stores = db.listStores().filter((s) => s.enabled && (storeId == null || s.id === storeId) && (!only || only.has(s.id)))
  if (!stores.length) return
  emit({ running: true, completed: 0, total: stores.length, currentStore: stores[0].name, results: [] })
  await refreshRates()
  const results: SyncStoreResult[] = []
  const alerts: NewAlert[] = []
  await mapLimit(stores, STORE_CONCURRENCY, async (store) => {
    emit({ currentStore: store.name })
    results.push(await syncStore(store, alerts, pages))
    emit({ completed: results.length, results: [...results] })
  })
  db.purgeOldRemoved()
  emit({ running: false, currentStore: null, lastRunAt: new Date().toISOString() })
  if (alerts.length) alertListener(alerts)

  // Product pages queued during the sync, read now at each store's usual pace.
  const reads = takePendingReads()
  if (reads.length) {
    const byStore = new Map<number, (() => Promise<number>)[]>()
    for (const r of reads) byStore.set(r.storeId, [...(byStore.get(r.storeId) ?? []), r.run])
    const touched = new Set<number>()
    await mapLimit([...byStore], PAGE_READ_CONCURRENCY, async ([id, runs]) => {
      for (const run of runs) if ((await run()) > 0) touched.add(id)
    })
    if (touched.size && queued === undefined) await runSync(undefined, touched, 'cached')
  }

  const next = queued
  queued = undefined
  if (next === null) await runSync()
  else if (next) for (const id of next) await runSync(id)
}
