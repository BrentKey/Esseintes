export type Gender = 'men' | 'women' | 'unisex' | 'unknown'
export type GenderPreference = 'men' | 'women' | 'all'
export type StoreGender = 'mixed' | 'men' | 'women'
export type Platform = 'shopify' | 'woocommerce' | 'generic'

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
  productCount: number
  createdAt: string
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

export interface ProductDetail extends Product {
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
