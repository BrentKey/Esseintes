import type { Gender } from '@shared/types'
import { WOMEN_ONLY_CATEGORIES } from '@shared/categories'

// Ordered: the first matching rule wins, so specific items come before the
// generic words they contain ("t-shirt" before "shirt", "sunglasses" before "glasses").
const CATEGORY_RULES: [string, RegExp][] = [
  ['Grooming', /\b(fragrances?|cologne|parfum|perfume|eau de|shampoo|conditioner|moisturi[sz]er|grooming|skincare|deodorant|shaving|razor|soap|body wash|hand cream|beard oil|candles?)\b/],
  ['Sunglasses', /\b(sunglass(es)?|sun ?glasses|shades)\b/],
  ['Glasses', /\b(optical|opticals|eyeglass(es)?|spectacles|frames?|glasses|eyewear|prescription|lens(es)?|blue ?light)\b/],
  ['Watches', /\b(watch(?! ?caps?)(es)?|wristwatch(es)?|timepieces?|chronograph)\b/],
  ['Jewellery', /\b(ring(?![- ]?spun)s?|signet|necklaces?|bracelets?|earrings?|pendants?|jewell?ery|cufflinks?|bangles?|tie ?(bar|clip)s?|brooch(es)?)\b/],
  ['Shoes', /\b(shoes?|sneakers?|trainers?|boots?|loafers?|sandals?|slides?|derbys?|brogues?|mules?|espadrilles?|footwear|slippers?|clogs?|moccasins?|oxfords? shoes?|monk ?straps?)\b/],
  ['Bags', /\b(bags?|backpacks?|totes?|holdalls?|duffle|duffel|briefcases?|rucksacks?|messenger|pouch(es)?|weekender|satchels?|crossbody|luggage|suitcases?)\b/],
  ['Ties & Pocket Squares', /\b(knit(ted)? ties?|silk ties?|neckties?|bow ?ties?)\b/],
  ['Swimwear', /\b(swim|swimwear|swimsuits?|swim ?shorts|board ?shorts|trunks swim)\b/],
  ['Underwear & Socks', /\b(socks?|boxers?|briefs|underwear|trunks|undershirts?|vest top|leg ?warmers?)\b/],
  ['Loungewear', /\b(pyjamas?|pajamas?|loungewear|robes?|dressing gown|nightwear|sleepwear)\b/],
  ['Shorts', /\b(shorts)\b/],
  ['Suits & Blazers', /\b(suits?|blazers?|sport ?coats?|tuxedos?|waistcoats?|tailoring|dinner jacket)\b/],
  ['Coats & Jackets', /\b(coats?|jackets?|parkas?|anoraks?|gilets?|bombers?|overcoats?|trench|puffers?|windbreakers?|shackets?|chore|outerwear|blousons?|harrington|peacoat|raincoat|down vest|body ?warmer)\b/],
  ['Sweats & Hoodies', /\b(hoodies?|hooded|sweatshirts?|sweats?|crewneck sweat|track ?tops?|zip[- ]?ups?|fleece)\b/],
  ['Polos', /\b(polos?(?! ?necks?)|polo shirts?|rugby)\b/],
  ['Knitwear', /\b(knit(?!(ted)? ties?\b)|knits|knitted(?! ties?\b)|knitwear|sweaters?|jumpers?|cardigans?|pullovers?|turtlenecks?|roll ?necks?|merino|cashmere crew|mock ?neck)\b/],
  ['T-Shirts & Tops', /\b(t-?shirts?|tees?|tank|tanks|vests?|henleys?|long ?sleeves?|longsleeves?|tops?|camisoles?|bodysuits?)\b/],
  ['Shirts', /\b(shirts?|overshirts?|oxford|button[- ]?down|flannel|shirting)\b/],
  ['Jeans', /\b(jeans?|denim trousers|selvedge)\b/],
  ['Trousers', /\b(trousers?|pants|chinos?|joggers?|sweatpants|slacks|cargos?|fatigues?|bottoms)\b/],
  ['Dresses & Skirts', /\b(dress|dresses|skirts?|blouses?|bras?|bikinis?|leggings|jumpsuits?|gowns?|tunics?|kaftans?)\b/],
  ['Hats & Caps', /\b(hats?|caps?|beanies?|beret|bucket hat|headwear|balaclavas?|fedora|flat cap|trapper)\b/],
  ['Belts', /\b(belts?|braces|suspenders)\b/],
  ['Wallets & Leather Goods', /\b(wallets?|card ?(holders?|cases?|wallets?)|billfolds?|coin (purse|pouch)|key ?(rings?|chains?|holders?|fobs?)|passport (holders?|covers?)|leather goods|small leather)\b/],
  ['Scarves & Gloves', /\b(scarf|scarves|snoods?|gloves?|mittens?|foulards?|shawls?|bandanas?|neckerchiefs?)\b/],
  ['Ties & Pocket Squares', /\b(ties?|bow ?ties?|neckties?|pocket squares?|cravats?)\b/],
  ['Home & Lifestyle', /\b(mugs?|cups?|books?|magazines?|issue \d+|printed (matter|goods)|posters?|prints?|blankets?|throws?|towels?|cushions?|homewares?|trays?|bowls?|plates?|vases?|carafes?|bottle openers?|glassware|ceramics?|incense|souvenirs?|kitchen|wine|bikes?|bicycles?|bar tape|playing cards|games?|stationery|notebooks?|pens?|objects?|decor|lighters?|ashtrays?)\b/],
  ['Other Accessories', /\b(umbrellas?|lanyards?|accessor(y|ies)|patches|pins?|badges?|cleaning cloth|cases?|straps?|phone|airpods|keyrings?|sachets?)\b/]
]

export function classifyCategory(productType: string, title: string, tags: string[]): string {
  // Product type is the most deliberate signal, then the title, then the tags.
  for (const text of [productType, title, tags.join(' , ')]) {
    const t = normalize(text)
    if (!t) continue
    for (const [name, re] of CATEGORY_RULES) if (re.test(t)) return name
  }
  return 'Other'
}

const MEN = /\b(men|mens|man|male|menswear|homme|hommes|uomo|herren|him|gents?)\b/
const WOMEN = /\b(women|womens|wmns|woman|female|womenswear|ladies|lady|femme|femmes|donna|damen|her)\b/
const UNISEX = /\b(unisex|genderless|gender neutral|all gender|genderfluid)\b/

/**
 * Gender from the product's own words. Collection membership (the store's
 * men's/women's sections) is more reliable and wins when available.
 */
export function classifyGender(
  texts: { productType: string; title: string; tags: string[]; url: string },
  category: string,
  collectionHint: Gender | null
): Gender {
  if (WOMEN_ONLY_CATEGORIES.includes(category)) return 'women'
  const titleText = normalize(texts.title)
  // An explicit "Women's ..." in the title beats a store filing it under men.
  if (WOMEN.test(titleText) && !MEN.test(titleText)) return 'women'
  if (MEN.test(titleText) && !WOMEN.test(titleText)) return 'men'
  if (collectionHint) return collectionHint

  let path = ''
  try {
    path = new URL(texts.url).pathname
  } catch {
    /* not a URL */
  }
  const t = normalize([texts.productType, texts.tags.join(' '), path.replace(/[-/]/g, ' ')].join(' '))
  if (UNISEX.test(t)) return 'unisex'
  const m = MEN.test(t)
  const w = WOMEN.test(t)
  if (m && w) return 'unisex'
  if (m) return 'men'
  if (w) return 'women'
  return 'unknown'
}

/** Classifies a store collection/category name as a men's or women's section. */
export function collectionGender(handle: string, title: string): 'men' | 'women' | null {
  const t = normalize(`${handle.replace(/-/g, ' ')} ${title}`)
  const m = MEN.test(t)
  const w = WOMEN.test(t)
  if (m === w) return null
  return m ? 'men' : 'women'
}

function normalize(s: string): string {
  return (s || '').toLowerCase().replace(/[’']/g, '').replace(/[_/|,()]+/g, ' ')
}

const SIZE_OPTION = /\b(size|sizes|waist|length|inseam|shoe|chest|collar|fit|taille|größe)\b/i

export function isSizeOption(name: string): boolean {
  return SIZE_OPTION.test(name) && !/\b(colou?r|style|material)\b/i.test(name)
}

const SIZE_ALIASES: Record<string, string> = {
  'EXTRA SMALL': 'XS', 'X-SMALL': 'XS', SMALL: 'S', MEDIUM: 'M', LARGE: 'L',
  'EXTRA LARGE': 'XL', 'X-LARGE': 'XL', 'XX-LARGE': 'XXL', '2XL': 'XXL', '3XL': 'XXXL',
  'ONE SIZE': 'OS', 'O/S': 'OS', ONESIZE: 'OS'
}

export function normalizeSize(label: string): string {
  const s = label.trim().toUpperCase().replace(/\s+/g, ' ')
  return SIZE_ALIASES[s] ?? s
}

/** True when a size label is one of the user's sizes, e.g. "32" matches "32 / Regular" or "32W". */
export function sizeMatches(label: string, mySizes: string[]): boolean {
  const s = normalizeSize(label)
  return mySizes.some((mine) => {
    const m = normalizeSize(mine)
    if (!m) return false
    if (s === m) return true
    const esc = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${esc}(?![0-9.])`).test(s) || new RegExp(`(^|[ /(-])${esc}([ /)]|$)`).test(s)
  })
}
