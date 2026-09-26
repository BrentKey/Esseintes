import type { Api, Product, Promotion } from '@shared/types'

declare global {
  interface Window {
    api: Api
  }
}

export const api = window.api

const formatters = new Map<string, Intl.NumberFormat>()
export function money(amount: number, currency: string): string {
  // Cents only matter on small prices; larger ones read better rounded.
  const cents = amount < 100 && Math.round(amount * 100) % 100 !== 0
  const key = `${currency}:${cents}`
  let f = formatters.get(key)
  if (!f) {
    try {
      f = new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })
    } catch {
      f = new Intl.NumberFormat(undefined, { maximumFractionDigits: cents ? 2 : 0 })
    }
    formatters.set(key, f)
  }
  return f.format(amount)
}

export function discountPercent(p: Pick<Product, 'price' | 'compareAtPrice'>): number | null {
  if (!p.compareAtPrice || p.compareAtPrice <= p.price) return null
  return Math.round((1 - p.price / p.compareAtPrice) * 100)
}

/** Best store-wide promotion that would apply on top of the listed price. */
export function bestSitewidePromo(promos: Promotion[], storeId: number): Promotion | null {
  return promos.filter((p) => p.storeId === storeId && p.sitewide && p.percent).sort((a, b) => b.percent! - a.percent!)[0] ?? null
}

/** Requests a smaller rendition from CDNs that support it (Shopify). */
export function sized(url: string | undefined, width: number): string | undefined {
  if (!url) return url
  try {
    const u = new URL(url.startsWith('//') ? `https:${url}` : url)
    if (u.hostname.includes('cdn.shopify.com') || u.pathname.includes('/cdn/shop/')) u.searchParams.set('width', String(width))
    return u.toString()
  } catch {
    return url
  }
}

const LETTER_ORDER = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL', 'OS']
export function compareSizes(a: string, b: string): number {
  const ia = LETTER_ORDER.indexOf(a.toUpperCase())
  const ib = LETTER_ORDER.indexOf(b.toUpperCase())
  if (ia >= 0 && ib >= 0) return ia - ib
  if (ia >= 0) return -1
  if (ib >= 0) return 1
  const na = parseFloat(a)
  const nb = parseFloat(b)
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb
  if (!isNaN(na) !== !isNaN(nb)) return isNaN(na) ? 1 : -1
  return a.localeCompare(b, undefined, { numeric: true })
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function isRecent(iso: string | null, days: number): boolean {
  return !!iso && Date.now() - new Date(iso).getTime() < days * 86_400_000
}

const EN = /\b(the|and|with|in|of|for|is|made|from|this|our)\b/gi
const OTHER = /\b(il|la|le|les|di|della|del|con|per|è|und|der|die|das|mit|für|el|los|las|con|para|est|des|une|avec|dans|questo|realizzato)\b/gi

/** Rough check for descriptions that aren't in English. */
export function looksForeign(text: string): boolean {
  if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(text)) return true
  return (text.match(OTHER)?.length ?? 0) > (text.match(EN)?.length ?? 0) + 2
}

/** Opens a store page through Google Translate in the user's browser. */
export function translateUrl(url: string): string {
  return `https://translate.google.com/translate?sl=auto&tl=en&u=${encodeURIComponent(url)}`
}
