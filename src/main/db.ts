import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type {
  Alert,
  Colorway,
  ModelColourway,
  AlertKind,
  Facet,
  HomeData,
  Product,
  ProductDetail,
  ProductPage,
  ProductQuery,
  Promotion,
  ReviewItem,
  Settings,
  Store,
  StoreGender
} from '@shared/types'
import { normalizeSize, sizeMatches } from './classify'

let db: DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  platform TEXT,
  gender TEXT NOT NULL DEFAULT 'mixed',
  enabled INTEGER NOT NULL DEFAULT 1,
  currency TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  brand TEXT NOT NULL,
  description TEXT NOT NULL,
  url TEXT NOT NULL,
  product_type TEXT NOT NULL,
  tags TEXT NOT NULL,
  category TEXT NOT NULL,
  gender TEXT NOT NULL,
  images TEXT NOT NULL,
  price REAL NOT NULL,
  compare_at_price REAL,
  currency TEXT NOT NULL,
  sizes TEXT NOT NULL,
  available INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  initial INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  price_dropped_at TEXT,
  previous_price REAL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS products_store ON products(store_id);
CREATE INDEX IF NOT EXISTS products_first_seen ON products(first_seen_at);
CREATE INDEX IF NOT EXISTS products_category ON products(category);
CREATE TABLE IF NOT EXISTS product_sizes (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  norm TEXT NOT NULL,
  available INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS product_sizes_product ON product_sizes(product_id);
CREATE TABLE IF NOT EXISTS price_history (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price REAL NOT NULL,
  compare_at_price REAL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS price_history_product ON price_history(product_id);
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  percent REAL,
  code TEXT,
  sitewide INTEGER NOT NULL DEFAULT 0,
  manual INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  dismissed INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(store_id, text)
);
CREATE TABLE IF NOT EXISTS favorites (
  product_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alerts_created ON alerts(created_at);
CREATE TABLE IF NOT EXISTS rates (
  currency TEXT PRIMARY KEY,
  per_usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_items (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  group_key TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (store_id, id)
);
CREATE TABLE IF NOT EXISTS detail_cache (
  store TEXT NOT NULL,
  item TEXT NOT NULL,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (store, item)
);
`

const DEFAULT_SETTINGS: Settings = {
  gender: 'all',
  includeUnknownGender: true,
  mySizes: [],
  onlyMySizes: false,
  hiddenBrands: [],
  hiddenCategories: [],
  notifyPriceDrops: true,
  notifyBackInStock: true,
  refreshHours: 6,
  currency: 'USD',
  lastVisitAt: null,
  onboarded: false
}

const now = () => new Date().toISOString()
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
export const REDUCED_WINDOW_DAYS = 14
// What's New holds everything that arrived in the last NEW_DAYS (new colours
// included). A newly added store's first import isn't really new to the store,
// so it only counts for NEW_IMPORT_DAYS. When nothing qualifies, the most
// recent NEW_FALLBACK items are shown instead.
const NEW_DAYS = 10
const NEW_IMPORT_DAYS = 1
const NEW_FALLBACK = 70

export function openDb(file: string) {
  db = new DatabaseSync(file)
  statements.clear()
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY;')
  db.exec(SCHEMA)
  // Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them to existing databases.
  ensureColumn('products', 'position', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('promotions', 'dismissed', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('stores', 'scope', 'TEXT')
  ensureColumn('products', 'colors', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn('products', 'model_key', 'TEXT')
  ensureColumn('products', 'color_label', 'TEXT')
  ensureColumn('products', 'new_color_at', 'TEXT')
  ensureColumn('products', 'new_color_name', 'TEXT')
  ensureColumn('favorites', 'size', 'TEXT')
  ensureColumn('stores', 'source', 'TEXT')
  ensureColumn('stores', 'profile', 'TEXT')
  ensureColumn('stores', 'review', 'TEXT')
  ensureColumn('stores', 'rules', 'TEXT')
  ensureColumn('stores', 'new_groups', 'TEXT')
  ensureColumn('products', 'group_key', 'TEXT')
  runOnce('reset-price-history-2026-09-27', () => {
    // Earlier versions recorded prices from mis-read catalogues; start the history
    // again from each product's current price.
    db.exec('DELETE FROM price_history; UPDATE products SET price_dropped_at = NULL, previous_price = NULL')
    db.prepare('INSERT INTO price_history (product_id, price, compare_at_price, recorded_at) SELECT id, price, compare_at_price, ? FROM products').run(now())
  })
  runOnce('clear-drops-from-catalogue-switch', () =>
    // Markdowns flagged when stores first switched to their English/US catalogue weren't real.
    db.exec('UPDATE products SET price_dropped_at = NULL, previous_price = NULL')
  )
  runOnce('price-from-every-size-2026-10-02', () => {
    // Prices now come from every size, not just those in stock. Forgetting each
    // store's source makes its next sync skip markdown detection once, so items
    // whose cheaper size was sold out don't look reduced. Oliver Peoples drops
    // recorded under the old rule were sizes coming back into stock.
    db.exec('UPDATE stores SET source = NULL')
    db.exec("UPDATE products SET price_dropped_at = NULL, previous_price = NULL WHERE store_id IN (SELECT id FROM stores WHERE url LIKE '%oliverpeoples.com%')")
  })
  db.exec('CREATE INDEX IF NOT EXISTS products_model ON products(model_key)')
  // Clear "just reduced" flags left by exchange-rate wobble before markdowns needed to be 5%+.
  db.prepare('UPDATE products SET price_dropped_at = NULL, previous_price = NULL WHERE previous_price IS NOT NULL AND price > previous_price * ?').run(1 - MARKDOWN)
  // Lets queries filter by the user's sizes using the same fuzzy matching as the UI.
  loadRates()
  db.function('to_display', { deterministic: false }, (amount: unknown, currency: unknown) =>
    convert(Number(amount), String(currency)) ?? Number(amount)
  )
  // Called for every size row a query checks; there are only ~1k distinct labels,
  // so remember each answer until the saved sizes change.
  let matchesFor = ''
  const matches = new Map<string, number>()
  db.function('my_size', { deterministic: false }, (label: unknown) => {
    const mine = cachedSettings().mySizes
    const key = mine.join('\u0000')
    if (key !== matchesFor) {
      matches.clear()
      matchesFor = key
    }
    const l = String(label)
    let m = matches.get(l)
    if (m === undefined) matches.set(l, (m = sizeMatches(l, mine) ? 1 : 0))
    return m
  })
}

/** Runs a one-off data fix the first time the app sees it. */
function runOnce(name: string, fn: () => void) {
  const key = `_migration:${name}`
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) return
  fn()
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(now()))
}

function ensureColumn(table: string, column: string, definition: string) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  if (!exists) return
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

// Prepared statements for the hot sync path, compiled once per SQL string.
const statements = new Map<string, StatementSync>()
function stmt(sql: string): StatementSync {
  let st = statements.get(sql)
  if (!st) statements.set(sql, (st = db.prepare(sql)))
  return st
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ---------- settings ----------

let settingsCache: Settings | null = null

function cachedSettings(): Settings {
  return settingsCache ?? getSettings()
}

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const s: Settings = { ...DEFAULT_SETTINGS }
  for (const { key, value } of rows) if (key in s) (s as any)[key] = JSON.parse(value)
  settingsCache = s
  return s
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v))
  return getSettings()
}

// ---------- stores ----------

const storeSelect = `
  SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id AND p.removed_at IS NULL AND p.available = 1) AS product_count
  FROM stores s`

function rowToStore(r: any): Store {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    platform: r.platform,
    gender: r.gender,
    enabled: !!r.enabled,
    currency: r.currency,
    lastSyncedAt: r.last_synced_at,
    lastError: r.last_error,
    scope: r.scope ?? null,
    source: r.source ?? null,
    profile: r.profile ? JSON.parse(r.profile) : null,
    review: r.review ?? null,
    rules: r.rules ? JSON.parse(r.rules) : null,
    newGroups: r.new_groups ? JSON.parse(r.new_groups) : [],
    productCount: r.product_count ?? 0,
    createdAt: r.created_at
  }
}

export function listStores(): Store[] {
  return (db.prepare(`${storeSelect} ORDER BY s.name COLLATE NOCASE`).all() as any[]).map(rowToStore)
}

export function getStore(id: number): Store | null {
  const r = db.prepare(`${storeSelect} WHERE s.id = ?`).get(id)
  return r ? rowToStore(r) : null
}

/** New stores are held for review before anything reaches the feed. */
export function insertStore(url: string, name: string, gender: StoreGender): Store {
  const r = db.prepare("INSERT INTO stores (name, url, gender, created_at, review) VALUES (?, ?, ?, ?, 'reading')").run(name, url, gender, now())
  return getStore(Number(r.lastInsertRowid))!
}

export function updateStore(id: number, patch: Record<string, unknown>) {
  const cols: Record<string, string> = {
    name: 'name', gender: 'gender', enabled: 'enabled', platform: 'platform',
    currency: 'currency', lastSyncedAt: 'last_synced_at', lastError: 'last_error', scope: 'scope', source: 'source', profile: 'profile',
    review: 'review', rules: 'rules', newGroups: 'new_groups'
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!cols[k] || v === undefined) continue
    const value = typeof v === 'boolean' ? (v ? 1 : 0) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v
    db.prepare(`UPDATE stores SET ${cols[k]} = ? WHERE id = ?`).run(value as any, id)
  }
  return getStore(id)!
}

/**
 * Empties a store and sends it back for review: its pieces (with their saved
 * state and price history), its choices and anything held for review go.
 */
export function resetStore(id: number) {
  transaction(() => {
    db.prepare('DELETE FROM favorites WHERE product_id IN (SELECT id FROM products WHERE store_id = ?)').run(id)
    db.prepare('DELETE FROM products WHERE store_id = ?').run(id)
    db.prepare('DELETE FROM review_items WHERE store_id = ?').run(id)
    db.prepare(
      `UPDATE stores SET review = 'reading', rules = NULL, new_groups = NULL, profile = NULL, source = NULL,
         last_synced_at = NULL, last_error = NULL WHERE id = ?`
    ).run(id)
  })
}

// ---------- review ----------

export type ReviewInput = Omit<StoredProductInput, 'position'> & { groupKey: string }

/** Replaces what's held for a store's review with a fresh read. */
export function holdForReview(storeId: number, items: ReviewInput[]) {
  transaction(() => {
    db.prepare('DELETE FROM review_items WHERE store_id = ?').run(storeId)
    const ins = db.prepare('INSERT OR IGNORE INTO review_items (store_id, id, group_key, data) VALUES (?, ?, ?, ?)')
    for (const i of items) ins.run(storeId, i.id, i.groupKey, JSON.stringify(i))
  })
}

/** Everything held for a store's review, in the store's own order. */
export function heldForReview(storeId: number): ReviewInput[] {
  return (db.prepare('SELECT data FROM review_items WHERE store_id = ? ORDER BY rowid').all(storeId) as { data: string }[]).map((r) => JSON.parse(r.data))
}

export function clearReview(storeId: number) {
  db.prepare('DELETE FROM review_items WHERE store_id = ?').run(storeId)
}

const toReviewItem = (p: { id: string; title: string; images: string[]; price: number; currency: string; url: string }): ReviewItem => ({
  id: p.id,
  title: p.title,
  image: p.images[0] ?? null,
  price: p.price,
  currency: p.currency,
  url: p.url
})

/** Pieces in one group: held for review, or (for groups that appeared later) already in the feed. */
export function reviewItems(storeId: number, key: string): ReviewItem[] {
  const held = db.prepare('SELECT data FROM review_items WHERE store_id = ? AND group_key = ? ORDER BY rowid').all(storeId, key) as { data: string }[]
  if (held.length) return held.map((r) => toReviewItem(JSON.parse(r.data)))
  const rows = db
    .prepare('SELECT id, title, images, price, currency, url FROM products WHERE store_id = ? AND group_key = ? AND removed_at IS NULL ORDER BY position')
    .all(storeId, key) as any[]
  return rows.map((r) => toReviewItem({ ...r, images: JSON.parse(r.images) }))
}

/** Counts of a store's pieces in the feed by group (for groups that appeared after review). */
export function feedGroupCounts(storeId: number): Map<string, number> {
  const rows = db
    .prepare('SELECT group_key AS key, COUNT(*) AS n FROM products WHERE store_id = ? AND removed_at IS NULL AND group_key IS NOT NULL GROUP BY group_key')
    .all(storeId) as { key: string; n: number }[]
  return new Map(rows.map((r) => [r.key, r.n]))
}

/** Drops a store's pieces in the given groups from the feed entirely. Run inside a transaction. */
export function deleteGroups(storeId: number, keys: string[]) {
  for (const key of keys) {
    db.prepare('DELETE FROM favorites WHERE product_id IN (SELECT id FROM products WHERE store_id = ? AND group_key = ?)').run(storeId, key)
    db.prepare('DELETE FROM products WHERE store_id = ? AND group_key = ?').run(storeId, key)
  }
}

/** Moves a group of a store's pieces in the feed to another gender and/or category. */
export function relabelGroup(storeId: number, key: string, gender: string | null, category: string | null) {
  db.prepare('UPDATE products SET gender = COALESCE(?, gender), category = COALESCE(?, category) WHERE store_id = ? AND group_key = ?').run(
    gender,
    category,
    storeId,
    key
  )
}

export function deleteStore(id: number) {
  db.prepare('DELETE FROM stores WHERE id = ?').run(id)
}

// ---------- products (sync side) ----------

export interface StoredProductInput {
  id: string
  storeId: number
  externalId: string
  title: string
  brand: string
  description: string
  url: string
  productType: string
  tags: string[]
  category: string
  gender: string
  images: string[]
  price: number
  compareAtPrice: number | null
  currency: string
  sizes: { label: string; available: boolean }[]
  available: boolean
  /** Order in the store's own feed, used to interleave stores in "newest". */
  position: number
  colors: Colorway[]
  /** Groups separate listings of the same model (one per colour) together. */
  modelKey: string
  /** Colour named in the listing's title ("Slip On – Black" → "Black"), if any. */
  colorLabel: string | null
  /** The review group the piece was sorted into (see groupKey), at reviewed stores. */
  groupKey?: string | null
}

export function existingProducts(storeId: number) {
  const rows = db
    .prepare('SELECT id, external_id, url, price, compare_at_price, sizes, colors, available, removed_at FROM products WHERE store_id = ?')
    .all(storeId) as any[]
  return new Map(rows.map((r) => [r.id as string, r]))
}

export function upsertProduct(p: StoredProductInput, initial: boolean, existing: any | undefined, ignoreDrops = false) {
  const ts = now()
  const sizesJson = JSON.stringify(p.sizes)
  let priceDroppedAt: string | null = null
  let previousPrice: number | null = null
  if (!existing) {
    stmt(
      `INSERT INTO products (id, store_id, external_id, title, brand, description, url, product_type, tags, category, gender,
        images, price, compare_at_price, currency, sizes, available, first_seen_at, initial, last_seen_at, updated_at, position, colors,
        model_key, color_label, group_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      p.id, p.storeId, p.externalId, p.title, p.brand, p.description, p.url, p.productType, JSON.stringify(p.tags),
      p.category, p.gender, JSON.stringify(p.images), p.price, p.compareAtPrice, p.currency, sizesJson,
      p.available ? 1 : 0, ts, initial ? 1 : 0, ts, ts, p.position, JSON.stringify(p.colors), p.modelKey, p.colorLabel,
      p.groupKey ?? null
    )
    recordPrice(p.id, p.price, p.compareAtPrice, ts)
  } else {
    // Stores that sell in several currencies often let Shopify convert prices
    // automatically, so they wobble by a dollar or two as exchange rates move.
    // Treat small changes as noise and only call a real markdown a drop.
    const priceChanged = changedMeaningfully(existing.price, p.price) || changedMeaningfully(existing.compare_at_price, p.compareAtPrice)
    if (priceChanged) {
      recordPrice(p.id, p.price, p.compareAtPrice, ts)
      if (!ignoreDrops && p.price <= existing.price * (1 - MARKDOWN)) {
        priceDroppedAt = ts
        previousPrice = existing.price
      }
    }
    // A colour added to a listing we already had is a new arrival in its own right.
    const known = new Set((JSON.parse(existing.colors || '[]') as Colorway[]).map((c) => c.name))
    const newColor = known.size ? (p.colors.find((c) => !known.has(c.name))?.name ?? null) : null
    stmt(
      `UPDATE products SET title = ?, brand = ?, description = ?, url = ?, product_type = ?, tags = ?, category = ?, gender = ?,
        images = ?, price = ?, compare_at_price = ?, currency = ?, sizes = ?, available = ?, last_seen_at = ?, removed_at = NULL, position = ?,
        updated_at = CASE WHEN ? THEN ? ELSE updated_at END,
        price_dropped_at = COALESCE(?, CASE WHEN ? > COALESCE(previous_price, price) * (1 - ?) THEN NULL ELSE price_dropped_at END),
        previous_price = COALESCE(?, CASE WHEN ? > COALESCE(previous_price, price) * (1 - ?) THEN NULL ELSE previous_price END),
        colors = ?, model_key = ?, color_label = ?, group_key = ?,
        new_color_at = COALESCE(?, new_color_at), new_color_name = COALESCE(?, new_color_name)
       WHERE id = ?`
    ).run(
      p.title, p.brand, p.description, p.url, p.productType, JSON.stringify(p.tags), p.category, p.gender,
      JSON.stringify(p.images), p.price, p.compareAtPrice, p.currency, sizesJson, p.available ? 1 : 0, ts, p.position,
      priceChanged || existing.sizes !== sizesJson || !!existing.available !== p.available ? 1 : 0, ts,
      priceDroppedAt, p.price, MARKDOWN, previousPrice, p.price, MARKDOWN, JSON.stringify(p.colors), p.modelKey, p.colorLabel,
      p.groupKey ?? null, newColor ? ts : null, newColor, p.id
    )
  }
  // Size rows only need rewriting when the sizes changed. (If normalizeSize ever
  // changes, add a runOnce migration that recomputes product_sizes.norm.)
  if (!existing || existing.sizes !== sizesJson) {
    stmt('DELETE FROM product_sizes WHERE product_id = ?').run(p.id)
    const ins = stmt('INSERT INTO product_sizes (product_id, label, norm, available) VALUES (?, ?, ?, ?)')
    for (const s of p.sizes) ins.run(p.id, s.label, normalizeSize(s.label), s.available ? 1 : 0)
  }
  return { priceDropped: priceDroppedAt !== null }
}

/** Smallest drop that counts as a markdown (5%). */
const MARKDOWN = 0.05
/** Changes under 2% are treated as exchange-rate noise. */
const NOISE = 0.02

function changedMeaningfully(before: number | null, after: number | null): boolean {
  if (before == null || after == null) return (before == null) !== (after == null)
  return Math.abs(after - before) > Math.max(0.01, before * NOISE)
}

function recordPrice(id: string, price: number, compare: number | null, ts: string) {
  stmt('INSERT INTO price_history (product_id, price, compare_at_price, recorded_at) VALUES (?, ?, ?, ?)').run(id, price, compare, ts)
}

export function markRemoved(ids: string[]) {
  const stmt = db.prepare('UPDATE products SET removed_at = ? WHERE id = ? AND removed_at IS NULL')
  const ts = now()
  for (const id of ids) stmt.run(ts, id)
}

/** Deletes products gone for 30+ days unless they're in the wishlist. */
export function purgeOldRemoved() {
  db.prepare('DELETE FROM alerts WHERE created_at < ?').run(daysAgo(60))
  db.prepare(
    `DELETE FROM products WHERE removed_at IS NOT NULL AND removed_at < ? AND id NOT IN (SELECT product_id FROM favorites)`
  ).run(daysAgo(30))
}

// ---------- promotions ----------

export function replaceDetectedPromotions(storeId: number, promos: { text: string; percent: number | null; code: string | null; sitewide: boolean }[]) {
  const ts = now()
  db.prepare('UPDATE promotions SET active = 0 WHERE store_id = ? AND manual = 0').run(storeId)
  const stmt = db.prepare(
    `INSERT INTO promotions (store_id, text, percent, code, sitewide, manual, active, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)
     ON CONFLICT(store_id, text) DO UPDATE SET active = 1, last_seen_at = excluded.last_seen_at,
       percent = excluded.percent, code = excluded.code, sitewide = excluded.sitewide`
  )
  for (const p of promos) stmt.run(storeId, p.text, p.percent, p.code, p.sitewide ? 1 : 0, ts, ts)
}

export function addManualPromotion(storeId: number, text: string, percent: number | null, code: string | null) {
  const ts = now()
  db.prepare(
    `INSERT INTO promotions (store_id, text, percent, code, sitewide, manual, active, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, 1, 1, 1, ?, ?)
     ON CONFLICT(store_id, text) DO UPDATE SET manual = 1, active = 1, percent = excluded.percent, code = excluded.code`
  ).run(storeId, text, percent, code, ts, ts)
}

/** Manual promotions are deleted; detected ones are hidden so the next sync doesn't bring them back. */
export function deletePromotion(id: number) {
  db.prepare('DELETE FROM promotions WHERE id = ? AND manual = 1').run(id)
  db.prepare('UPDATE promotions SET dismissed = 1 WHERE id = ?').run(id)
}

export function listPromotions(storeId?: number): Promotion[] {
  const rows = db
    .prepare(
      `SELECT pr.*, s.name AS store_name FROM promotions pr JOIN stores s ON s.id = pr.store_id
       WHERE pr.active = 1 AND pr.dismissed = 0 AND s.enabled = 1 ${storeId ? 'AND pr.store_id = ?' : ''}
       ORDER BY pr.sitewide DESC, pr.percent DESC, pr.first_seen_at DESC`
    )
    .all(...(storeId ? [storeId] : [])) as any[]
  return rows.map((r) => ({
    id: r.id,
    storeId: r.store_id,
    storeName: r.store_name,
    text: r.text,
    percent: r.percent,
    code: r.code,
    sitewide: !!r.sitewide,
    manual: !!r.manual,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at
  }))
}

// ---------- currency ----------

// Units of each currency per 1 USD.
let rates = new Map<string, number>()

function loadRates() {
  rates = new Map((db.prepare('SELECT currency, per_usd FROM rates').all() as any[]).map((r) => [r.currency, r.per_usd]))
}

export function saveRates(perUsd: Record<string, number>) {
  transaction(() => {
    const stmt = db.prepare('INSERT INTO rates (currency, per_usd) VALUES (?, ?) ON CONFLICT(currency) DO UPDATE SET per_usd = excluded.per_usd')
    for (const [c, r] of Object.entries(perUsd)) if (r > 0) stmt.run(c, r)
    db.prepare(`INSERT INTO settings (key, value) VALUES ('_ratesUpdatedAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(now()))
  })
  loadRates()
}

export function ratesUpdatedAt(): string | null {
  const r = db.prepare(`SELECT value FROM settings WHERE key = '_ratesUpdatedAt'`).get() as any
  return r ? JSON.parse(r.value) : null
}

export function availableCurrencies(): string[] {
  return [...rates.keys()].sort()
}

/** Converts into the display currency, or null when a rate is missing. */
function convert(amount: number, from: string): number | null {
  const to = cachedSettings().currency
  if (from === to) return amount
  const a = rates.get(from)
  const b = rates.get(to)
  if (!a || !b) return null
  return (amount / a) * b
}

const round = (n: number) => Math.round(n * 100) / 100

/** Formats a price in the user's display currency (falls back to the original). */
export function formatPrice(amount: number, currency: string): string {
  const converted = convert(amount, currency)
  const cur = converted == null ? currency : cachedSettings().currency
  const value = converted ?? amount
  try {
    const cents = value < 100 && Math.round(value * 100) % 100 !== 0
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur, maximumFractionDigits: cents ? 2 : 0 }).format(round(value))
  } catch {
    return value.toFixed(2)
  }
}

// ---------- products (read side) ----------

const recent = (iso: string | null, days: number) => !!iso && Date.now() - new Date(iso).getTime() < days * 86_400_000

function rowToProduct(r: any): Product {
  const display = cachedSettings().currency
  // Converted prices are approximate anyway, so show them in whole units.
  const conv = (v: number | null) => (v == null ? null : Math.round(convert(v, r.currency)!))
  const converted = r.currency !== display && convert(r.price, r.currency) != null
  return {
    id: r.id,
    storeId: r.store_id,
    storeName: r.store_name,
    title: r.title,
    brand: r.brand,
    description: r.description,
    url: r.url,
    category: r.category,
    gender: r.gender,
    images: JSON.parse(r.images),
    price: converted ? conv(r.price)! : r.price,
    compareAtPrice: converted ? conv(r.compare_at_price) : r.compare_at_price,
    currency: converted ? display : r.currency,
    originalPrice: converted ? r.price : null,
    originalCurrency: converted ? r.currency : null,
    sizes: JSON.parse(r.sizes),
    available: !!r.available,
    firstSeenAt: r.first_seen_at,
    // Items loaded when a store is first added are only "new" briefly.
    isNew: recent(r.first_seen_at, r.initial ? NEW_IMPORT_DAYS : NEW_DAYS) || recent(r.new_color_at, NEW_DAYS),
    newColor: recent(r.new_color_at, NEW_DAYS) ? r.new_color_name : null,
    colors: JSON.parse(r.colors ?? '[]'),
    colorLabel: r.color_label ?? null,
    colourCount: Number(r.model_colors ?? Math.max(1, JSON.parse(r.colors ?? '[]').length)),
    priceDroppedAt: r.price_dropped_at,
    previousPrice: converted ? conv(r.previous_price) : r.previous_price,
    favorite: !!r.favorite,
    favoriteSize: r.favorite_size ?? null
  }
}

const productSelect = `
  SELECT p.*, s.name AS store_name, (f.product_id IS NOT NULL) AS favorite, f.size AS favorite_size
  FROM products p
  JOIN stores s ON s.id = p.store_id
  LEFT JOIN favorites f ON f.product_id = p.id`

type Where = { sql: string[]; params: any[] }
type FacetKey = 'category' | 'store' | 'brand' | 'size'

/** Baseline visibility: live products from enabled stores matching the gender preference. */
function baseWhere(settings: Settings, wishlist = false): Where {
  const w: Where = { sql: ['p.removed_at IS NULL', 's.enabled = 1'], params: [] }
  // The wishlist shows everything saved, whatever the current filters, stock or hidden lists.
  if (!wishlist) {
    w.sql.push('p.available = 1')
    if (settings.hiddenBrands.length) {
      w.sql.push(`p.brand NOT IN (${settings.hiddenBrands.map(() => '?').join(',')})`)
      w.params.push(...settings.hiddenBrands)
    }
    if (settings.hiddenCategories.length) {
      w.sql.push(`p.category NOT IN (${settings.hiddenCategories.map(() => '?').join(',')})`)
      w.params.push(...settings.hiddenCategories)
    }
  }
  if (settings.gender !== 'all' && !wishlist) {
    const genders = [settings.gender, 'unisex', ...(settings.includeUnknownGender ? ['unknown'] : [])]
    // At a reviewed store, what's in the feed is what the user chose to keep.
    w.sql.push(`(s.rules IS NOT NULL OR p.gender IN (${genders.map(() => '?').join(',')}))`)
    w.params.push(...genders)
  }
  if (settings.onlyMySizes && settings.mySizes.length && !wishlist) {
    w.sql.push(`(NOT EXISTS (SELECT 1 FROM product_sizes ps WHERE ps.product_id = p.id)
      OR EXISTS (SELECT 1 FROM product_sizes ps WHERE ps.product_id = p.id AND ps.available = 1 AND my_size(ps.label) = 1))`)
  }
  return w
}

function buildWhere(q: ProductQuery, settings: Settings, skip?: FacetKey): Where {
  const w = baseWhere(settings, q.favoritesOnly)
  const add = (sql: string, ...params: any[]) => {
    w.sql.push(sql)
    w.params.push(...params)
  }
  const inList = (n: number) => Array(n).fill('?').join(',')

  for (const term of (q.search ?? '').trim().split(/\s+/).filter(Boolean)) {
    const like = `%${term}%`
    add('(p.title LIKE ? OR p.brand LIKE ? OR p.category LIKE ? OR p.tags LIKE ? OR p.product_type LIKE ? OR s.name LIKE ?)', like, like, like, like, like, like)
  }
  if (q.categories?.length && skip !== 'category') add(`p.category IN (${inList(q.categories.length)})`, ...q.categories)
  if (q.storeIds?.length && skip !== 'store') add(`p.store_id IN (${inList(q.storeIds.length)})`, ...q.storeIds)
  if (q.brands?.length && skip !== 'brand') add(`p.brand IN (${inList(q.brands.length)})`, ...q.brands)
  if (q.sizes?.length && skip !== 'size')
    add(`EXISTS (SELECT 1 FROM product_sizes ps WHERE ps.product_id = p.id AND ps.available = 1 AND ps.norm IN (${inList(q.sizes.length)}))`, ...q.sizes)
  if (q.onSale) add('p.compare_at_price IS NOT NULL')
  if (q.justReduced) add('p.price_dropped_at > ?', daysAgo(REDUCED_WINDOW_DAYS))
  if (q.newSince) add('p.first_seen_at > ? AND p.initial = 0', q.newSince)
  if (q.newArrivals) add(...newArrivals(settings))
  if (q.favoritesOnly) add('f.product_id IS NOT NULL')
  // In stock in the size saved with the item (or, with none saved, any of my sizes; one-size items count).
  if (q.inMySize)
    add(`p.available = 1 AND (NOT EXISTS (SELECT 1 FROM product_sizes ps WHERE ps.product_id = p.id)
      OR EXISTS (SELECT 1 FROM product_sizes ps WHERE ps.product_id = p.id AND ps.available = 1
        AND (ps.label = f.size OR (f.size IS NULL AND my_size(ps.label) = 1))))`)
  if (q.minPrice != null) add('to_display(p.price, p.currency) >= ?', q.minPrice)
  if (q.maxPrice != null) add('to_display(p.price, p.currency) <= ?', q.maxPrice)
  return w
}

const FRESH = '(p.new_color_at > ? OR p.first_seen_at > CASE WHEN p.initial = 1 THEN ? ELSE ? END)'

/** The SQL condition (and its parameters) selecting What's New under the user's settings. */
function newArrivals(settings: Settings): [string, ...any[]] {
  const fresh = [daysAgo(NEW_DAYS), daysAgo(NEW_IMPORT_DAYS), daysAgo(NEW_DAYS)]
  const base = baseWhere(settings)
  const from = `FROM products p JOIN stores s ON s.id = p.store_id LEFT JOIN favorites f ON f.product_id = p.id WHERE ${base.sql.join(' AND ')}`
  const any = db.prepare(`SELECT 1 ${from} AND ${FRESH} LIMIT 1`).get(...base.params, ...fresh)
  if (any) return [FRESH, ...fresh]
  return [`p.id IN (SELECT p.id ${from} ORDER BY ${NEWEST} LIMIT ${NEW_FALLBACK})`, ...base.params]
}

// A new colour of an existing listing counts as new, from the moment it appeared.
const NEWEST = `CASE WHEN p.new_color_at IS NOT NULL THEN 0 ELSE p.initial END ASC,
  substr(COALESCE(p.new_color_at, p.first_seen_at), 1, 13) DESC, p.position ASC, p.store_id`
const ORDER: Record<string, string> = {
  newest: NEWEST,
  'price-asc': 'to_display(p.price, p.currency) ASC',
  'price-desc': 'to_display(p.price, p.currency) DESC',
  discount: 'CASE WHEN p.compare_at_price IS NULL THEN 0 ELSE (p.compare_at_price - p.price) / p.compare_at_price END DESC, p.first_seen_at DESC'
}

/** Browsing shows one card per model; What's New and the collection show each colourway. */
const grouped = (q: ProductQuery) => !q.individual && !q.favoritesOnly && !q.newSince
const MODEL = 'COALESCE(p.model_key, p.id)'

function facet(q: ProductQuery, settings: Settings, key: FacetKey): Facet[] {
  const w = buildWhere(q, settings, key)
  const where = w.sql.join(' AND ')
  const from = `FROM products p JOIN stores s ON s.id = p.store_id LEFT JOIN favorites f ON f.product_id = p.id WHERE ${where}`
  const count = grouped(q) ? `COUNT(DISTINCT ${MODEL})` : 'COUNT(DISTINCT p.id)'
  let rows: any[]
  switch (key) {
    case 'category':
      rows = db.prepare(`SELECT p.category AS value, p.category AS label, ${count} AS count ${from} GROUP BY p.category ORDER BY count DESC`).all(...w.params) as any[]
      break
    case 'store':
      rows = db.prepare(`SELECT p.store_id AS value, s.name AS label, ${count} AS count ${from} GROUP BY p.store_id ORDER BY s.name COLLATE NOCASE`).all(...w.params) as any[]
      break
    case 'brand':
      rows = db.prepare(`SELECT p.brand AS value, p.brand AS label, ${count} AS count ${from} AND p.brand != '' GROUP BY p.brand ORDER BY p.brand COLLATE NOCASE`).all(...w.params) as any[]
      break
    case 'size':
      rows = db
        .prepare(
          `SELECT ps.norm AS value, ps.norm AS label, ${count} AS count
           FROM products p JOIN stores s ON s.id = p.store_id LEFT JOIN favorites f ON f.product_id = p.id
           JOIN product_sizes ps ON ps.product_id = p.id AND ps.available = 1
           WHERE ${where} GROUP BY ps.norm ORDER BY count DESC LIMIT 60`
        )
        .all(...w.params) as any[]
      break
  }
  return rows.map((r) => ({ value: String(r.value), label: String(r.label), count: Number(r.count) }))
}

export function queryProducts(q: ProductQuery): ProductPage {
  const settings = cachedSettings()
  const w = buildWhere(q, settings)
  const where = w.sql.join(' AND ')
  const order = ORDER[q.sort ?? 'newest'] ?? ORDER.newest
  const from = `FROM products p JOIN stores s ON s.id = p.store_id LEFT JOIN favorites f ON f.product_id = p.id WHERE ${where}`
  let total: number
  let rows: any[]
  const want = q.facets ?? 'all'
  if (grouped(q)) {
    total = want === 'none' ? -1 : Number((db.prepare(`SELECT COUNT(DISTINCT ${MODEL}) AS n ${from}`).get(...w.params) as any).n)
    // The best-matching listing represents each model; colourways are counted across all of them.
    // Ranking runs on ids only; full rows are loaded just for the page returned.
    rows = db
      .prepare(
        `WITH m AS (
           SELECT p.id,
             ROW_NUMBER() OVER (PARTITION BY ${MODEL} ORDER BY ${order}) AS rn,
             ROW_NUMBER() OVER (ORDER BY ${order}) AS ord,
             SUM(MAX(1, json_array_length(p.colors))) OVER (PARTITION BY ${MODEL}) AS model_colors
           ${from}),
         page AS (SELECT id, ord, model_colors FROM m WHERE rn = 1 ORDER BY ord LIMIT ? OFFSET ?)
         SELECT p.*, s.name AS store_name, (f.product_id IS NOT NULL) AS favorite, f.size AS favorite_size, page.model_colors
         FROM page JOIN products p ON p.id = page.id JOIN stores s ON s.id = p.store_id LEFT JOIN favorites f ON f.product_id = p.id
         ORDER BY page.ord`
      )
      .all(...w.params, q.limit ?? 60, q.offset ?? 0) as any[]
  } else {
    total = want === 'none' ? -1 : Number((db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...w.params) as any).n)
    rows = db.prepare(`${productSelect} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...w.params, q.limit ?? 60, q.offset ?? 0) as any[]
  }
  return {
    items: rows.map(rowToProduct),
    total,
    facets: {
      categories: want === 'none' ? [] : facet(q, settings, 'category'),
      stores: want === 'all' ? facet(q, settings, 'store') : [],
      brands: want === 'all' ? facet(q, settings, 'brand') : [],
      sizes: want === 'all' ? facet(q, settings, 'size') : []
    }
  }
}

export function getProduct(id: string): ProductDetail | null {
  const r = db.prepare(`${productSelect} WHERE p.id = ?`).get(id)
  if (!r) return null
  const product = rowToProduct(r)
  const from = (r as any).currency as string
  const conv = (v: number | null) => (v == null || product.originalCurrency == null ? v : Math.round(convert(v, from) ?? v))
  const history = (db
    .prepare('SELECT price, compare_at_price, recorded_at FROM price_history WHERE product_id = ? ORDER BY recorded_at')
    .all(id) as any[]).map((h) => ({ price: conv(h.price)!, compareAtPrice: conv(h.compare_at_price), recordedAt: h.recorded_at }))
  return { ...product, priceHistory: history, promotions: listPromotions(product.storeId), model: modelColourways(r) }
}

/**
 * Every colourway of a model, across however the store lists them: several
 * colours inside one listing, one listing per colour, or a mix.
 */
function modelColourways(r: any): ModelColourway[] {
  const siblings = (db
    .prepare(`${productSelect} WHERE p.removed_at IS NULL AND ${r.model_key ? 'p.model_key = ?' : 'p.id = ?'} ORDER BY p.available DESC, p.position`)
    .all(r.model_key ?? r.id) as any[]).map(rowToProduct)
  const out: ModelColourway[] = []
  for (const s of siblings) {
    if (s.colors.length > 1) {
      for (const c of s.colors)
        out.push({
          productId: s.id,
          name: c.name,
          image: c.image ?? s.images[0] ?? null,
          images: c.images?.length ? c.images : c.image ? [c.image] : s.images,
          available: c.available && s.available,
          isNew: s.newColor === c.name || (s.isNew && !s.newColor)
        })
    } else {
      out.push({
        productId: s.id,
        name: s.colorLabel ?? s.colors[0]?.name ?? null,
        image: s.images[0] ?? null,
        images: s.images,
        available: s.available,
        isNew: s.isNew
      })
    }
  }
  return out
}

// ---------- wishlist alerts ----------

/** Saved products and the size saved with each (null when none was chosen). */
export function favoriteSizes(): Map<string, string | null> {
  return new Map((db.prepare('SELECT product_id, size FROM favorites').all() as any[]).map((r) => [r.product_id, r.size]))
}

export function insertAlerts(alerts: { productId: string; kind: AlertKind; message: string }[]) {
  const stmt = db.prepare('INSERT INTO alerts (product_id, kind, message, created_at) VALUES (?, ?, ?, ?)')
  const ts = now()
  for (const a of alerts) stmt.run(a.productId, a.kind, a.message, ts)
}

export function listAlerts(limit = 50): Alert[] {
  const rows = db
    .prepare(
      `SELECT a.id AS alert_id, a.kind, a.message, a.created_at AS alert_created_at, a.read, p.*, s.name AS store_name, 1 AS favorite
       FROM alerts a JOIN products p ON p.id = a.product_id JOIN stores s ON s.id = p.store_id
       WHERE a.created_at > ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`
    )
    .all(daysAgo(30), limit) as any[]
  return rows.map((r) => ({
    id: r.alert_id,
    kind: r.kind,
    message: r.message,
    createdAt: r.alert_created_at,
    read: !!r.read,
    product: rowToProduct(r)
  }))
}

export function markAlertsRead() {
  db.prepare('UPDATE alerts SET read = 1 WHERE read = 0').run()
}

export function toggleFavorite(id: string): boolean {
  const exists = db.prepare('SELECT 1 FROM favorites WHERE product_id = ?').get(id)
  if (exists) db.prepare('DELETE FROM favorites WHERE product_id = ?').run(id)
  else db.prepare('INSERT INTO favorites (product_id, created_at) VALUES (?, ?)').run(id, now())
  return !exists
}

/** Saves (or re-saves) a product to the collection with the size to track. */
export function saveFavorite(id: string, size: string | null) {
  db.prepare(
    'INSERT INTO favorites (product_id, created_at, size) VALUES (?, ?, ?) ON CONFLICT(product_id) DO UPDATE SET size = excluded.size'
  ).run(id, now(), size)
}

export function getHome(previousVisit: string | null): HomeData {
  const settings = cachedSettings()
  const base = baseWhere(settings)
  const where = base.sql.join(' AND ')
  const from = `FROM products p JOIN stores s ON s.id = p.store_id LEFT JOIN favorites f ON f.product_id = p.id WHERE ${where}`
  const list = (extra: string, order: string, limit: number, ...params: any[]) =>
    (db.prepare(`${productSelect} WHERE ${where} ${extra} ORDER BY ${order} LIMIT ${limit}`).all(...base.params, ...params) as any[]).map(rowToProduct)
  const count = (extra: string, ...params: any[]) =>
    Number((db.prepare(`SELECT COUNT(*) AS n ${from} ${extra}`).get(...base.params, ...params) as any).n)

  // Latest product per category supplies the tile image.
  const categories = (db
    .prepare(
      `SELECT p.category AS name, COUNT(DISTINCT COALESCE(p.model_key, p.id)) AS count,
        (SELECT json_extract(p2.images, '$[0]') FROM products p2 JOIN stores s2 ON s2.id = p2.store_id
          WHERE p2.category = p.category AND p2.removed_at IS NULL AND p2.available = 1 AND s2.enabled = 1
          ORDER BY p2.first_seen_at DESC LIMIT 1) AS image
       ${from} GROUP BY p.category ORDER BY count DESC`
    )
    .all(...base.params) as any[]).map((r) => ({ name: r.name, count: Number(r.count), image: r.image }))

  return {
    newIn: (() => {
      const [sql, ...params] = newArrivals(settings)
      return list(`AND ${sql}`, NEWEST, 24, ...params)
    })(),
    previousVisitAt: previousVisit,
    alerts: listAlerts(12),
    newSinceLastVisit: previousVisit ? count('AND p.first_seen_at > ? AND p.initial = 0', previousVisit) : 0,
    justReduced: list('AND p.price_dropped_at > ?', 'p.price_dropped_at DESC', 12, daysAgo(REDUCED_WINDOW_DAYS)),
    saleCount: count('AND p.compare_at_price IS NOT NULL'),
    promotions: listPromotions(),
    categories,
    stores: listStores().filter((s) => s.enabled)
  }
}

/** Product details a slow-reading adapter fetched earlier, keyed by item, with when each was read. */
export function detailCache(store: string): Map<string, { data: unknown; fetchedAt: string }> {
  const rows = db.prepare('SELECT item, data, fetched_at FROM detail_cache WHERE store = ?').all(store) as any[]
  return new Map(rows.map((r) => [r.item, { data: JSON.parse(r.data), fetchedAt: r.fetched_at }]))
}

export function saveDetail(store: string, item: string, data: unknown) {
  db.prepare('INSERT OR REPLACE INTO detail_cache (store, item, data, fetched_at) VALUES (?, ?, ?, ?)').run(store, item, JSON.stringify(data), now())
}
