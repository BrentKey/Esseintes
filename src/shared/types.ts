export type Gender = 'men' | 'women' | 'unisex' | 'unknown'
export type GenderPreference = 'men' | 'women' | 'all'
export type StoreGender = 'mixed' | 'men' | 'women'
export type Platform = 'shopify' | 'woocommerce' | 'depict' | 'auralee' | 'adss' | 'ebisumart' | 'generic'

export interface Size {
  label: string
  available: boolean
}

/** One colour option of a product, e.g. a frame/lens combination. */
export interface Colorway {
  name: string
  available: boolean
  image: string | null
  /** All photos of this colour, when the store provides more than one. */
  images?: string[]
}

export interface Store {
  id: number
  name: string
  url: string
  platform: Platform | null
  gender: StoreGender
  enabled: boolean
  currency: string | null
  lastSyncedAt: string | null
  lastError: string | null
  /** Department the last successful sync was scoped to. */
  scope: string | null
  /** Catalogue address the last sync read (changes when a store's English version is used). */
  source: string | null
  /** How the last sync decided men's and women's at this store. */
  profile: StoreProfile | null
  /**
   * A new (or started-over) store is read in full and held for review before
   * anything reaches the feed: 'reading' until the first read finishes, then
   * 'ready' until the user saves their choices. Null once reviewed.
   */
  review: 'reading' | 'ready' | null
  /** The user's choices from reviewing the store; null for stores added before reviews. */
  rules: StoreRules | null
  /** Groups that appeared after the review, kept for now and awaiting a decision. */
  newGroups: NewGroup[]
  productCount: number
  createdAt: string
}

/** How a group of a store's pieces was labelled: by gender, or as not for sale (lookbooks). */
export type GroupLabel = Gender | 'notForSale'

/** What to do with a group: leave it out, keep it as labelled, or keep it under another label. */
export type ReviewChoice = 'skip' | 'keep' | 'men' | 'women' | 'unisex'

export interface GroupRule {
  choice: ReviewChoice
  /** Files the group under another category ("Other" → "Bags"). */
  category?: string
}

/** A store's reviewed groups, keyed "label|category" (see groupKey). */
export interface StoreRules {
  groups: Record<string, GroupRule>
}

export interface NewGroup {
  key: string
  count: number
}

export interface ReviewItem {
  id: string
  title: string
  image: string | null
  price: number
  currency: string
  url: string
}

export interface ReviewGroup {
  key: string
  label: GroupLabel
  category: string
  count: number
  /** The choice the group starts with: the saved one, else the default for its label. */
  choice: ReviewChoice
  moveTo: string | null
  samples: ReviewItem[]
}

export interface StoreReview {
  store: Store
  /** 'initial': the first review of everything read; 'new': groups that appeared since. */
  mode: 'initial' | 'new'
  total: number
  groups: ReviewGroup[]
}

/** The key of a group of pieces: how they're labelled and which category they're in. */
export function groupKey(label: GroupLabel, category: string): string {
  return label === 'notForSale' ? 'notForSale|' : `${label}|${category}`
}

/**
 * How a store is read, decided from the store's own structure each sync: where
 * its men's/women's labels come from and which departments it divides by gender.
 */
export interface StoreProfile {
  /** Rules version; a change lets the next sync retire items the old rules kept. */
  version: number
  /**
   * The most reliable gender signal found: the store's own men's/women's sections,
   * a single-gender store, or only the products' own words.
   */
  source: 'sections' | 'single' | 'words'
  /** Items found in the store's men's sections, women's sections, both, or neither. */
  inMen: number
  inWomen: number
  inBoth: number
  inNeither: number
  /**
   * Departments whose items outside every men's section are taken to be women's
   * (set when a men's section holds nearly everything and there's no women's side).
   */
  menDepartments: string[]
  /** Set when the store sells to one gender; unlabelled items follow it. */
  storeGender: 'men' | 'women' | null
  /** Items set aside as not for sale (lookbook pages, placeholder listings). */
  notForSale: number
}

export interface Product {
  id: string
  storeId: number
  storeName: string
  title: string
  brand: string
  description: string
  url: string
  category: string
  gender: Gender
  images: string[]
  price: number
  compareAtPrice: number | null
  currency: string
  /** The store's own price when `price` has been converted to the display currency. */
  originalPrice: number | null
  originalCurrency: string | null
  sizes: Size[]
  colors: Colorway[]
  available: boolean
  firstSeenAt: string
  /** Arrived since the store was added (and within the last week), or gained a new colour. */
  isNew: boolean
  /** Name of a colour added to this listing in the last week. */
  newColor: string | null
  /** Colour named in the listing's title, for stores that list each colour separately. */
  colorLabel: string | null
  /** Colourways across the whole model (all listings of it at the store). */
  colourCount: number
  /** Size saved with this item in the collection. */
  favoriteSize: string | null
  priceDroppedAt: string | null
  previousPrice: number | null
  favorite: boolean
}

export interface PricePoint {
  price: number
  compareAtPrice: number | null
  recordedAt: string
}

/** One colour of a model, which may come from its own listing or a variant within one. */
export interface ModelColourway {
  productId: string
  name: string | null
  image: string | null
  images: string[]
  available: boolean
  isNew: boolean
}

/** A size table from a store's description: a header row (sizes) and a row per measurement. */
export interface SizeGuide {
  title: string | null
  header: string[]
  rows: string[][]
}

/** Facts shown above a product's description. */
export interface ProductFacts {
  colour: string | null
  composition: string | null
  madeIn: string | null
  sizeGuides: SizeGuide[]
}

export interface ProductDetail extends Product {
  facts: ProductFacts
  /** False until the product's own page has been read for facts its description lacks. */
  pageRead: boolean
  model: ModelColourway[]
  priceHistory: PricePoint[]
  promotions: Promotion[]
}

export interface Promotion {
  id: number
  storeId: number
  storeName: string
  text: string
  percent: number | null
  code: string | null
  sitewide: boolean
  manual: boolean
  firstSeenAt: string
  lastSeenAt: string
}

export type SortKey = 'newest' | 'price-asc' | 'price-desc' | 'discount'

export interface ProductQuery {
  search?: string
  categories?: string[]
  storeIds?: number[]
  brands?: string[]
  sizes?: string[]
  onSale?: boolean
  justReduced?: boolean
  newSince?: string
  /** What's New: recent arrivals, per the policy in db.ts. */
  newArrivals?: boolean
  favoritesOnly?: boolean
  /** Only items in stock in the size saved with them (collection) or my sizes. */
  inMySize?: boolean
  /** Show every colourway separately instead of one card per model. */
  individual?: boolean
  minPrice?: number
  maxPrice?: number
  sort?: SortKey
  limit?: number
  offset?: number
  /** Which filter counts to compute; 'none' also skips the total (returned as -1). Default 'all'. */
  facets?: 'all' | 'categories' | 'none'
}

export interface Facet {
  value: string
  label: string
  count: number
}

export interface ProductPage {
  items: Product[]
  total: number
  facets: {
    categories: Facet[]
    stores: Facet[]
    brands: Facet[]
    sizes: Facet[]
  }
}

export interface Settings {
  gender: GenderPreference
  includeUnknownGender: boolean
  mySizes: string[]
  onlyMySizes: boolean
  hiddenBrands: string[]
  hiddenCategories: string[]
  notifyPriceDrops: boolean
  notifyBackInStock: boolean
  refreshHours: number
  /** ISO code prices are shown in, e.g. USD. */
  currency: string
  lastVisitAt: string | null
  onboarded: boolean
}

export type AlertKind = 'price-drop' | 'back-in-stock'

export interface Alert {
  id: number
  kind: AlertKind
  message: string
  createdAt: string
  read: boolean
  product: Product
}

export interface ImportResult {
  added: string[]
  skipped: string[]
  failed: string[]
}

export interface HomeData {
  newIn: Product[]
  newSinceLastVisit: number
  alerts: Alert[]
  previousVisitAt: string | null
  justReduced: Product[]
  saleCount: number
  promotions: Promotion[]
  categories: { name: string; count: number; image: string | null }[]
  stores: Store[]
}

export interface SyncStoreResult {
  storeId: number
  storeName: string
  added: number
  updated: number
  removed: number
  priceDrops: number
  error: string | null
}

export interface SyncStatus {
  running: boolean
  currentStore: string | null
  completed: number
  total: number
  lastRunAt: string | null
  results: SyncStoreResult[]
}

export interface Api {
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  listStores(): Promise<Store[]>
  addStore(url: string, name?: string): Promise<Store>
  updateStore(id: number, patch: Partial<Pick<Store, 'name' | 'enabled'>>): Promise<Store>
  removeStore(id: number): Promise<void>
  addPromotion(storeId: number, text: string, percent: number | null, code: string | null): Promise<void>
  removePromotion(id: number): Promise<void>
  listPromotions(): Promise<Promotion[]>
  queryProducts(q: ProductQuery): Promise<ProductPage>
  getProduct(id: string): Promise<ProductDetail | null>
  getHome(): Promise<HomeData>
  /** Reads a product's page for the facts its description lacks (once; remembered). */
  readFacts(id: string): Promise<ProductFacts | null>
  getReview(storeId: number): Promise<StoreReview>
  getReviewItems(storeId: number, key: string): Promise<ReviewItem[]>
  saveReview(storeId: number, rules: StoreRules): Promise<void>
  startOver(storeId: number): Promise<void>
  toggleFavorite(id: string): Promise<boolean>
  saveFavorite(id: string, size: string | null): Promise<void>
  sync(storeId?: number): Promise<void>
  getSyncStatus(): Promise<SyncStatus>
  onSyncStatus(cb: (s: SyncStatus) => void): () => void
  openExternal(url: string): Promise<void>
  importStores(): Promise<ImportResult | null>
  exportStores(): Promise<boolean>
  listAlerts(): Promise<Alert[]>
  listCurrencies(): Promise<string[]>
  markAlertsRead(): Promise<void>
  /** Fired when the user clicks a desktop notification. */
  onOpenProduct(cb: (id: string) => void): () => void
}
