import { load } from 'cheerio'
import { fetchText } from './http'

export interface DetectedPromotion {
  text: string
  percent: number | null
  code: string | null
  sitewide: boolean
}

// Announcement bars and banners are where stores usually advertise
// store-wide sales that aren't reflected in individual product prices.
const CONTAINERS = [
  'announcement', 'promo', 'banner', 'marquee', 'ticker', 'topbar', 'top-bar', 'top_bar',
  'notice', 'header__message', 'header-message', 'alert-bar', 'sale-bar', 'usp', 'hero'
]
  .map((k) => `[class*="${k}"], [id*="${k}"]`)
  .join(', ')

const SALE = /\d{1,2}\s?%\s*off|\bsale\b|\bdiscount|\bpromo(tion)?\b|\bcode\b|\boff everything|\bsite-?wide|\bstore-?wide|black friday|cyber monday|end of season|\bextra\s+\d{1,2}\s?%|\bup to\s+\d{1,2}\s?%/i
const NOISE = /cookie|newsletter|subscribe|sign up|signup|first order|join our|log ?in|gift card|javascript|\bshow\b|\bfilter|\bsort\b|items only|view all/i
// Without a percentage or code, the word "sale" alone is usually just a nav link,
// so require phrasing that announces an actual event.
const SALE_EVENT = /sale (is )?(now )?(on|live|ends|starts|continues)|now on sale|(archive|private|summer|winter|seasonal|end of season|mid-?season|holiday|warehouse|sample|flash) sale|black friday|cyber monday|further reductions|final reductions|up to \d/i
const SITEWIDE = /everything|site-?\s?wide|store-?\s?wide|entire (store|site|order)|all (orders|items|products|styles|full[- ]price)|\boff all\b|whole (store|site)/i
const CODE = /(?:code|Code|CODE)\s*:?\s*["“'‘]?([A-Z0-9][A-Z0-9_-]{2,19})\b/

export function parsePromotions(html: string): DetectedPromotion[] {
  const $ = load(html)
  $('script, style, noscript, svg, nav ul ul').remove()
  const texts = new Set<string>()
  $(CONTAINERS).each((_, el) => {
    // Use the innermost text blocks so one banner doesn't swallow the page.
    $(el)
      .find('p, span, a, strong, h1, h2, h3, h4, div')
      .addBack()
      .each((_, node) => {
        const $n = $(node)
        if ($n.children('div, p, section, ul').length) return
        // Scrolling marquees repeat their message; keep one copy.
        const t = $n.text().replace(/\s+/g, ' ').trim().replace(/^(.+?)(?:\s*\1)+$/, '$1')
        if (t.length >= 6 && t.length <= 160) texts.add(t)
      })
  })

  const found: DetectedPromotion[] = []
  for (const text of texts) {
    if (!SALE.test(text) || NOISE.test(text)) continue
    // Skip fragments of a longer message we already kept.
    if (found.some((f) => f.text.includes(text) || text.includes(f.text))) continue
    const percents = [...text.matchAll(/(\d{1,2})\s?%/g)].map((m) => parseInt(m[1], 10))
    const code = text.match(CODE)?.[1] ?? null
    if (!percents.length && !code && !SALE_EVENT.test(text)) continue
    found.push({
      text,
      percent: percents.length ? Math.max(...percents) : null,
      code,
      sitewide: SITEWIDE.test(text)
    })
    if (found.length >= 5) break
  }
  return found
}

export async function detectPromotions(base: string): Promise<DetectedPromotion[]> {
  return parsePromotions(await fetchText(base))
}
