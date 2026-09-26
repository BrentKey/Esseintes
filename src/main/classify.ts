import type { Gender } from '@shared/types'
import { WOMEN_ONLY_CATEGORIES } from '@shared/categories'

// Ordered: the first matching rule wins, so specific items come before the
// generic words they contain ("t-shirt" before "shirt", "sunglasses" before "glasses").
const CATEGORY_RULES: [string, RegExp][] = [
  ['Grooming', /\b(fragrances?|cologne|parfum|perfume|eau de|shampoo|conditioner|moisturi[sz]er|grooming|skincare|deodorant|shaving|razor|soap|body wash|hand cream|beard oil|candles?)\b/],
  ['Sunglasses', /\b(sunglass(es)?|sun ?glasses|shades)\b/],
  ['Glasses', /\b(optical|opticals|eyeglass(es)?|spectacles|frames?|glasses|eyewear|prescription|lens(es)?|blue ?light (lens(es)?|glasses|filter|blocking))\b/],
  ['Watches', /\b(watch(?! ?caps?)(es)?|wristwatch(es)?|timepieces?|chronograph)\b/],
  ['Jewellery', /\b(ring(?![- ]?spun)s?|signet|necklaces?|bracelets?|earrings?|pendants?|jewell?ery|cufflinks?|bangles?|tie ?(bar|clip)s?|brooch(es)?)\b/],
  ['Shoes', /\b(shoes?|sneakers?|trainers?|boots?|loafers?|sandals?|slides?|derbys?|brogues?|mules?|espadrilles?|footwear|slippers?|clogs?|moccasins?|oxfords? shoes?|monk ?straps?)\b/],
  ['Bags', /\b(bags?|carry-?alls?|backpacks?|totes?|holdalls?|duffle|duffel|briefcases?|rucksacks?|messenger|pouch(es)?|weekender|satchels?|crossbody|luggage|suitcases?)\b/],
  ['Ties & Pocket Squares', /\b(knit(ted)? ties?|silk ties?|neckties?|bow ?ties?)\b/],
  ['Hats & Caps', /\b((knit(ted)?|wool|woolen|woollen|cashmere|merino|ribbed) (caps?|hats?)|beanies?)\b/],
  ['Swimwear', /\b(swim|swimwear|swimsuits?|swim ?shorts|board ?shorts|trunks swim)\b/],
  ['Underwear & Socks', /\b(socks?|boxers?|briefs|underwear|trunks|undershirts?|vest top|leg ?warmers?)\b/],
  ['Loungewear', /\b(pyjamas?|pajamas?|loungewear|robes?|dressing gown|nightwear|sleepwear)\b/],
  ['Shorts', /\b(shorts|bermudas?|half tights)\b/],
  ['Suits & Blazers', /\b(suits?|blazers?|sport ?coats?|tuxedos?|waistcoats?|tailoring|dinner jacket)\b/],
  ['Coats & Jackets', /\b(coats?|jackets?|parkas?|anoraks?|gilets?|bombers?|overcoats?|trench|puffers?|windbreakers?|shackets?|chore|outerwear|overjackets?|blousons?|harrington|peacoat|caban|raincoat|down vest|body ?warmer|sahariana|safari jacket|sahara)\b/],
  ['Sweats & Hoodies', /\b(hoodies?|hooded|sweatshirts?|sweats?|crewneck sweat|track ?tops?|zip[- ]?ups?|(half|quarter)[- ]?zip|fleece|\w*fleece)\b/],
  ['Polos', /\b(polos?(?! ?necks?)|polo shirts?|rugby)\b/],
  ['Knitwear', /\b(knit(?!(ted)? ties?\b)|knits|knitted(?! ties?\b)|knitwear|sweaters?|jumpers?|cardigans?|pullovers?|turtlenecks?|roll ?necks?|merino|cashmere crew|mock ?neck|crew ?necks?|v-?necks?)\b/],
  ['T-Shirts & Tops', /\b(t-?shirts?|tees?|tank|tanks|vests?|singlets?|base ?layers?|henleys?|long ?sleeves?|longsleeves?|tops?|camisoles?|bodysuits?|jerseys?(?! (trousers?|pants|shorts|joggers?|shirts?|polos?|dress)))\b/],
  ['Shirts', /\b(shirts?|overshirts?|oxford|button[- ]?down|flannel|shirting)\b/],
  ['Jeans', /\b(jeans?|denim trousers|selvedge)\b/],
  ['Trousers', /\b(trousers?|pants|chinos?|joggers?|sweatpants|slacks|cargos?|fatigues?|bottoms|tights)\b/],
  ['Dresses & Skirts', /\b(dress|dresses|skirts?|blouses?|bras?|bikinis?|leggings|jumpsuits?|gowns?|tunics?|kaftans?)\b/],
  ['Hats & Caps', /\b(hats?|caps?|beanies?|beret|bucket hat|headwear|balaclavas?|fedora|flat cap|trapper|ear ?warmers?|earmuffs?)\b/],
  ['Belts', /\b(belts?|braces|suspenders)\b/],
  ['Wallets & Leather Goods', /\b(wallets?|card ?(holders?|cases?|wallets?)|billfolds?|coin (purse|pouch)|key ?(rings?|chains?|holders?|fobs?)|passport (holders?|covers?)|leather goods|small leather)\b/],
  ['Scarves & Gloves', /\b(scarf|scarves|snoods?|\w*gloves?|neck (warmers?|gaiters?|coolers?|clooers?)|mittens?|foulards?|shawls?|bandanas?|neckerchiefs?)\b/],
  ['Ties & Pocket Squares', /\b(ties?|bow ?ties?|neckties?|pocket squares?|cravats?)\b/],
  ['Home & Lifestyle', /\b(napkins?|table ?cloths?|tablelcoths?|table runners?|tea towels?|placemats?|coasters?|mugs?|cups?|books?|magazines?|issue \d+|printed (matter|goods)|posters?|prints?|blankets?|throws?|towels?|cushions?|homewares?|trays?|bowls?|plates?|vases?|carafes?|bottle openers?|glassware|ceramics?|incense|souvenirs?|kitchen|wine|bikes?|bicycles?|bar tape|playing cards|games?|stationery|notebooks?|pens?|objects?|decor|lighters?|ashtrays?|matches|match ?box(es)?|flasks?|tumblers?|set of \d|speedcups?)\b/],
  ['Other Accessories', /\b(umbrellas?|lanyards?|patches|pins?|badges?|cleaning cloth|cases?|phone|airpods|keyrings?|sachets?)\b/]
]

// Item words in a title that beat the store's product type. Some stores file
// everything under one type (an eyewear brand calling its cases, cloths and
// lens sprays "sunglasses"), but the title names the actual thing.
const TITLE_OVERRIDES: [string, RegExp][] = [
  ['Wallets & Leather Goods', /\b(card ?(holders?|cases?|wallets?)|wallets?)\b/],
  // Deliberately narrow: "cloth" and "cord" are also fabrics ("Wool Cloth Jacket", "Cord Trousers").
  ['Other Accessories', /\b((?<!(brief|suit|pillow) ?)cases?|cleaners?|cleansers?|cleaning|(cleaning|lens|polishing|microfib(re|er)) cloths?|care kit|kits?|(spectacle|eyewear|glasses|sunglass(es)?) (cords?|chains?|straps?)|retainers?|refills?|lanyards?)\b/],
  ['Grooming', /\b(fragrances?|eau de (parfum|toilette)|cologne|perfumes?|candles?)\b/]
]

// Eyewear product types that mean sunglasses (Oliver Peoples and Akoni use "Sun").
const SUN_TYPE = /^(sun|sunwear|sun ?glass(es)?|sunglass(es)?|clip-? ?ons?|snow goggles?|goggles?)$/
const OPTICAL_TYPE = /\b(optical|opticals|optics?|rx|prescription|eyeglass(es)?|ophthalmic)\b/
// The only real difference between sunglasses and glasses is the lens.
const SUN_LENS = /\b(sun|solar|polari[sz]ed|tinted|photochromic|mirror(ed)? lens|gradient|g-?15|uv ?400|(grey|gray|green|brown|dark|smoke|blue|rose) lens(es)?|dark (grey|gray|green|brown)|solid (black|grey|gray|brown|green))\b/

/**
 * `extra` carries weaker hints (URL path, colourway names) that only settle
 * whether a frame is sun or optical.
 */
export function classifyCategory(productType: string, title: string, tags: string[], extra = ''): string {
  const pt = normalize(productType)
  if (SUN_TYPE.test(pt)) return 'Sunglasses'
  const t0 = normalize(title)
  // …unless the title also names a bag or shoe ("Chain Strap Bag", "Strap Sandal").
  if (!/\b(bags?|backpacks?|totes?|sandals?|shoes?|boots?|loafers?|sneakers?)\b/.test(t0))
    for (const [name, re] of TITLE_OVERRIDES) if (re.test(t0)) return name
  // Product type is the most deliberate signal, then the title, then the tags.
  let found = 'Other'
  for (const text of [productType, title, tags.join(' , ')]) {
    const t = normalize(text)
    if (!t) continue
    const hit = CATEGORY_RULES.find(([, re]) => re.test(t))
    if (hit) {
      found = hit[0]
      break
    }
  }
  if (found === 'Glasses' && !OPTICAL_TYPE.test(pt)) {
    const hints = normalize([title, tags.join(' '), extra.replace(/[-/]/g, ' ')].join(' '))
    if (SUN_LENS.test(hints) && !/\b(clear|demo|blue ?light|rx|optical)\b/.test(normalize(title))) return 'Sunglasses'
  }
  // A store's catch-all "Accessories" type is the last resort, not the first.
  if (found === 'Other' && /\baccessor(y|ies)\b/.test(normalize([productType, tags.join(' ')].join(' ')))) return 'Other Accessories'
  return found
}

// Plural forms only: "kid leather", "Beach Boy" and "baby alpaca" are adult items.
const KIDS = /\b(kids|boys|girls|children|childrens|juniors?|toddlers?|infants?|youth|little ones|bambin[oi]|enfants?)\b/

/** Children's clothing, which the app never collects. */
export function isKids(...texts: string[]): boolean {
  return KIDS.test(normalize(texts.join(' ').replace(/[-/]/g, ' ')))
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
  // Garments that are womenswear whatever section a store files them under.
  if (/\b(palazzo|culottes?|blouses?|camisoles?|kaftans?)\b/.test(normalize(texts.title))) return 'women'
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
