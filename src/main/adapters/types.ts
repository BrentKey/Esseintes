import type { Colorway, Gender, Platform, Size } from '@shared/types'

/** A product as read from a store, before classification and storage. */
export interface RawProduct {
  externalId: string
  handle: string
  title: string
  brand: string
  descriptionHtml: string
  url: string
  productType: string
  tags: string[]
  images: string[]
  price: number
  compareAtPrice: number | null
  currency: string | null
  sizes: Size[]
  /** Colour options; empty when the product comes in one colour. */
  colors: Colorway[]
  available: boolean
  /** Gender implied by the store collection the product was found in. */
  collectionGender: Gender | null
}

export interface FetchResult {
  products: RawProduct[]
  currency: string | null
  /** False when the catalogue may be incomplete; removals are skipped then. */
  complete: boolean
}

export interface Adapter {
  platform: Platform
  detect(base: string): Promise<boolean>
  fetchAll(base: string, onProgress: (count: number) => void): Promise<FetchResult>
}
