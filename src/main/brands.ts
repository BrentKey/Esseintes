// Shopify's "vendor" field is meant to be the brand, but stores use it for all
// sorts of things: season codes ("AW26", "HDSS25"), internal labels
// ("PERMANENTS", "Drakes - UK/ROW") or collaborations ("AKOG X BASSO").

const FILLER = /^(not specified|default|default vendor|vendor|unknown|n\/a|none|-|sale|outlet|archive|samples?|new|new in|core|essentials|permanents?|main|collection|clothing|apparel|accessories|footwear|shop|store)$/i
// Letters (optional) followed by a two- or four-digit year: AW26, SS 2026, HDAW25, FW25-26.
const SEASON = /^[a-z]{0,6}[\s-]?\d{2}(\d{2})?([\s/-]\d{2,4})?$/i
const COLLAB = /\s+(?:x|×)\s+/i

const key = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '')
const initials = (s: string) =>
  s
    .normalize('NFD')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toLowerCase())
    .join('')

function isUsable(vendor: string): boolean {
  const v = vendor.trim()
  return !!v && !v.startsWith('@') && !FILLER.test(v) && !SEASON.test(v)
}

/** The brand side of a collaboration: "AKOG X BASSO" → "AKOG". */
const collabBase = (vendor: string) => vendor.trim().split(COLLAB)[0].trim()

/** How a vendor name relates to the store: the same name, a longer/shorter form of it, or its initials. */
function relation(vendor: string, storeName: string): 'name' | 'initials' | null {
  const v = key(vendor)
  const s = key(storeName)
  if (!v || !s) return null
  if (v === s || (s.length >= 3 && (v.startsWith(s) || s.startsWith(v)) && v.length >= 3)) return 'name'
  const init = initials(storeName)
  if (init.length >= 3 && (v === init || v.startsWith(init))) return 'initials'
  return null
}

/**
 * Looks at every vendor value a store uses and returns a function giving each
 * product's brand. Stores that essentially sell one brand get that brand on
 * everything (collaborations included); multi-brand stores keep each vendor.
 */
export function brandResolver(storeName: string, vendors: string[]): (vendor: string) => string {
  const usable = vendors.filter(isUsable).map(collabBase)
  const counts = new Map<string, { name: string; n: number }>()
  for (const v of usable) {
    const k = key(v)
    const c = counts.get(k) ?? { name: v, n: 0 }
    c.n++
    counts.set(k, c)
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n)
  const top = ranked[0]
  const topShare = top ? top.n / usable.length : 0
  const topRelation = top ? relation(top.name, storeName) : null

  // The house brand's display name: the vendor's own spelling when it's the
  // store name (e.g. "Akoni Eyewear" rather than "Akoni Eyewear - Official
  // Store"), otherwise the store name (initials like "AKOG" aren't a name, and
  // "Drakes - UK/ROW" is a label, not a better spelling of "Drakes").
  const house = topRelation === 'name' && key(top!.name).length <= key(storeName).length ? top!.name : storeName

  const singleBrand =
    !top || (topRelation && topShare >= 0.6) || (ranked.length <= 2 && topShare >= 0.7) || ranked.filter((r) => r.n / usable.length >= 0.03).length <= 1

  if (singleBrand) return () => house
  return (vendor) => {
    if (!isUsable(vendor)) return house
    const base = collabBase(vendor)
    return relation(base, storeName) ? house : vendor.trim()
  }
}

/** Removes "Official Store"-style suffixes from a site's title. */
export function cleanStoreName(name: string): string {
  return name
    .replace(/\s*[-–—|:·]\s*(the\s+)?(official\s+)?(online\s+)?(store|shop|site|website|boutique|home)(\s+online)?\s*$/i, '')
    .replace(/^official\s+/i, '')
    .trim()
}
