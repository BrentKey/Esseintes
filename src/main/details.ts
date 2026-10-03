import { load, type CheerioAPI } from 'cheerio'
import type { ProductFacts, SizeGuide } from '@shared/types'

// The facts worth showing above a product's description, and its size guide.
// They come from the store's description; what that leaves out (stores often
// keep composition and colour in a tab on the product page) is read from the
// product page when the piece is opened (see readPageFacts).

const FIBRES =
  'cotton|wool|linen|flax|silk|cashmere|polyester|nylon|polyamide|viscose|elastane|elastan|spandex|lycra|leather|suede|alpaca|mohair|merino|hemp|ramie|lyocell|tencel|modal|acrylic|cupro|acetate|yak|camel|angora|vicuna|vicuña|shearling|calfskin|lambskin|cowhide|goatskin|rayon|jute|bamboo|polyurethane|elastodiene|metallic|lurex|down|feather|kapok|horsehair|rubber|nubuck|canvas|denim|corduroy|tweed|flannel|gold|silver|brass|steel|titanium'
const FIBRE = new RegExp(`\\b(${FIBRES})\\b`, 'i')
// "100% wool" or, as some Japanese stores write it, "WOOL 100%".
const PERCENT_FIBRE = new RegExp(
  `\\d{1,3}(?:[.,]\\d+)?\\s?%\\s*(?:[a-z-]+\\s+){0,2}(${FIBRES})\\b|\\b(${FIBRES})\\s*\\d{1,3}(?:[.,]\\d+)?\\s?%`,
  'i'
)
const COMPOSITION_LABEL = /^(?:composition|fabric(?:ation)?|materials?|content|shell|outer|main|body|lining|fibre|fiber)\b(?:\s*(?:&|and)\s*care)?\s*[:\-–：|]\s*/i
const COLOUR_LABEL = /^colou?r(?:way)?s?\s*[:\-–]\s*/i
const COUNTRIES =
  'italy|portugal|japan|france|england|scotland|ireland|wales|britain|great britain|the uk|uk|the usa|usa|the united states|united states|america|spain|germany|india|china|peru|bolivia|romania|turkey|türkiye|morocco|tunisia|mongolia|nepal|vietnam|thailand|korea|south korea|taiwan|mexico|canada|australia|new zealand|sweden|denmark|norway|finland|poland|lithuania|bulgaria|hungary|austria|switzerland|belgium|the netherlands|netherlands|greece|indonesia|sri lanka|bangladesh|pakistan|cambodia|madagascar|guatemala|colombia|ecuador|brazil|argentina|uruguay|chile'
const MADE_IN = new RegExp(`\\b(?:made|handmade|crafted|manufactured|produced|knitted|woven|sewn)\\s+in\\s+(${COUNTRIES})\\b`, 'i')

// Words that name a colour, for telling "in Old Rose" (a colour) from "in Wool Drill" (a fabric).
const COLOUR_WORDS =
  'black|white|ivory|ecru|cream|off-white|natural|ecru|bone|stone|sand|beige|camel|tan|khaki|taupe|brown|chocolate|coffee|mocha|espresso|walnut|chestnut|cognac|caramel|tobacco|rust|terracotta|burgundy|bordeaux|wine|oxblood|maroon|red|rouge|scarlet|crimson|cherry|raspberry|pink|rose|blush|salmon|coral|peach|apricot|orange|amber|mustard|ochre|gold|golden|yellow|lemon|butter|lime|olive|green|sage|mint|moss|forest|bottle|emerald|jade|teal|turquoise|aqua|petrol|blue|navy|indigo|cobalt|azure|sky|denim|midnight|ink|royal|cornflower|powder|slate|steel|grey|gray|charcoal|graphite|anthracite|silver|smoke|ash|pewter|purple|violet|lilac|lavender|mauve|plum|aubergine|fuchsia|magenta|multi|multicolou?r|melange|marl|heather|ombre|tortoise|havana|honey|nude|oat|oatmeal|biscuit|fawn|mushroom|putty|chalk|snow|milk|vanilla|sepia|umber|sienna|henna|madder|saffron|turmeric|mango|tangerine|pumpkin|brick|clay|earth|dune|desert|army|military|hunter|pine|fern|pistachio|celadon|seafoam|ocean|marine|sea|storm|dusk|dusky|dark|light|pale|deep|washed|faded|bright|stripes?|check'
const COLOUR_WORD = new RegExp(`\\b(${COLOUR_WORDS})\\b`, 'i')
// Fabrics, weaves and materials: a title's "in …" naming one of these isn't (only) a colour.
const MATERIAL = new RegExp(
  `\\b(${FIBRES}|drill|twill|jacquard|knit|knitted|ribbed|rib|blend|padded|quilted|fabric|leather|nappa|crochet|boucle|bouclé|seersucker|poplin|popeline|oxford|chambray|velvet|velour|terry|towelling|jersey|fleece|felt|gabardine|serge|crepe|satin|organza|tulle|mesh|lace|loden|moleskin|cord|herringbone|houndstooth|tweed|melton|piqué|pique|stone|lava|wood|horn|resin|enamel|ceramic|glass|paper|straw|raffia|wicker)\\b`,
  'i'
)

/**
 * Whether words a store uses for a piece's variant ("Old Rose", "Black") can be
 * shown as its colour: they must name a colour and nothing else ("Wool Drill"
 * and "Black Nappa Leather" are fabrics). Without a colour word they're left out,
 * since no colour beats a wrong one.
 */
export function colourName(words: string | null | undefined): string | null {
  const w = words?.trim()
  if (!w || w.length > 40) return null
  return COLOUR_WORD.test(w) && !MATERIAL.test(w) ? w : null
}

const SIZE_WORD = /^(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|one size|os|\d{1,2}(?:[.,]5)?|\d{2,3}\s?cm)$/i

/** Plain text from a store's description HTML, one line per paragraph or list item. */
export function htmlToText(html: string): string {
  if (!html) return ''
  const $ = load(html)
  return textOf($)
}

function textOf($: CheerioAPI): string {
  $('script, style, iframe, noscript').remove()
  $('br').replaceWith('\n')
  $('p, div, li, h1, h2, h3, h4, h5, h6, tr, dt, dd, summary').each((_, el) => {
    $(el).append('\n')
  })
  $('li').each((_, el) => {
    $(el).prepend('• ')
  })
  return $.root()
    .text()
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+• *\n*/g, '\n• ')
    .trim()
}

const cellText = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Takes size tables out of a description (they read as a column of loose
 * numbers once flattened) and returns them as size guides. Other small tables
 * ("Composition | 100% wool") become "Composition: 100% wool" lines.
 */
function takeTables($: CheerioAPI): SizeGuide[] {
  const guides: SizeGuide[] = []
  $('table').each((_, table) => {
    const rows = $(table)
      .find('tr')
      .map((_, tr) => [$(tr).find('th, td').map((_, td) => cellText($(td).text())).get()])
      .get() as string[][]
    const width = Math.max(0, ...rows.map((r) => r.length))
    if (rows.length < 2 || width < 2) return
    const cells = rows.flat()
    const sizeLike = cells.filter((c) => SIZE_WORD.test(c)).length
    const isSizeTable = sizeLike >= 3 || /\b(size|sizing|measure|chest|waist|inseam|shoulder|length|cm|inch)/i.test(cells.join(' '))
    if (isSizeTable) {
      // A heading cell like "Sizing (cm):" names the table.
      const first = rows[0][0]
      const title = /:$/.test(first) || /\b(sizing|size guide|measurements?)\b/i.test(first) ? first.replace(/:$/, '') : null
      guides.push({ title, header: rows[0].map((c, i) => (i === 0 && title ? '' : c)), rows: rows.slice(1) })
      $(table).remove()
    } else {
      $(table).replaceWith(rows.map((r) => `<p>${r.filter(Boolean).join(': ')}</p>`).join(''))
    }
  })
  return guides
}

/** Composition, colour and origin found in lines of text. `taken` collects the lines they came from. */
function factsFromLines(lines: string[], taken = new Set<number>()): Omit<ProductFacts, 'sizeGuides'> {
  // Bullets, list numbers and table pipes before the words.
  const clean = (l: string) => l.replace(/^(?:[•\-–*·|\s]+|\d{1,2}[.)]\s+)+/, '').trim()
  let lastComposition = -2
  let composition: string[] = []
  let colour: string | null = null
  let madeIn: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = clean(lines[i])
    if (!line || line.length > 220) continue
    if (!colour && COLOUR_LABEL.test(line)) {
      const value = line.replace(COLOUR_LABEL, '').split(/\s{2,}|\s[|/]\s|\bsize\b/i)[0].trim()
      if (value && value.length <= 40) {
        colour = value
        taken.add(i)
        continue
      }
    }
    // "Composition" on its own line, with the fibres on the next.
    if (composition.length === 0 && /^(composition|fabric|materials?|composition & care)\s*:?$/i.test(line) && PERCENT_FIBRE.test(clean(lines[i + 1] ?? ''))) {
      taken.add(i)
      continue
    }
    const labelled = COMPOSITION_LABEL.test(line) && (FIBRE.test(line) || /%/.test(line))
    // Composition is one line or a run of consecutive ones (shell, lining, trims).
    const continues = composition.length === 0 || i === lastComposition + 1
    if ((labelled || PERCENT_FIBRE.test(line)) && continues && composition.length < 3) {
      const value = labelled && /^(composition|fabric(?:ation)?|materials?|content|fibre|fiber)\b/i.test(line) ? line.replace(COMPOSITION_LABEL, '') : line
      // Pages often repeat a block (desktop and mobile layouts).
      if (!composition.some((c) => c.toLowerCase() === value.toLowerCase())) composition.push(value)
      lastComposition = i
      // A sentence that mentions the fabric stays in the description; a bare fact line moves up.
      if (labelled || line.length <= 80) taken.add(i)
      continue
    }
    if (!madeIn) {
      const m = line.match(MADE_IN)
      if (m) madeIn = titleCase(m[1])
    }
  }
  composition = composition.map((c) => c.replace(/[.;]\s*$/, ''))
  return { colour, composition: composition.length ? composition.join('; ') : null, madeIn }
}

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(usa|uk)\b/g, (w) => w.toUpperCase())
    .replace(/\b(?!the\b)([a-z])/g, (c) => c.toUpperCase())

/**
 * A description's text (without its size tables, and without the lines now
 * shown as facts) and the facts it gives. `colourHint` is the colour the store
 * names the piece in elsewhere (its single colour option, or its title).
 */
export function describe(html: string, colourHint: string | null): { text: string; facts: ProductFacts } {
  const $ = load(html || '')
  const sizeGuides = takeTables($)
  const lines = textOf($).split('\n')
  const taken = new Set<number>()
  const facts = factsFromLines(lines, taken)
  const text = lines
    .filter((_, i) => !taken.has(i))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, facts: { ...facts, colour: facts.colour ?? colourHint, sizeGuides } }
}

/**
 * Facts from a product's own page: its structured data first (schema.org
 * "color" and "material"), then labelled lines in the page's main content.
 */
export function pageFacts(html: string, title: string): Omit<ProductFacts, 'sizeGuides'> {
  const $ = load(html)
  let colour: string | null = null
  let composition: string | null = null
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const found = [JSON.parse($(el).text())].flat(3).flatMap((d: any) => [d, ...(d?.['@graph'] ?? [])])
      const product = found.find((d: any) => /product/i.test(String(d?.['@type'] ?? '')))
      if (!product) return
      const c = [product.color].flat()[0]
      const m = [product.material].flat()[0]
      if (typeof c === 'string' && c.trim() && c.length <= 40) colour ??= c.trim()
      if (typeof m === 'string' && FIBRE.test(m)) composition ??= m.trim()
    } catch {
      /* not JSON */
    }
  })
  // Menus, footers and "you may also like" carry other products' words.
  $('header, footer, nav, script, style, noscript, svg, form[action*="/cart/add"] select').remove()
  $('[class*="recommend"], [class*="related"], [id*="recommend"], [id*="related"], [class*="footer"], [class*="drawer"], [class*="cart"]').remove()
  const root = $('main').length ? load($('main').first().html() ?? '') : $
  let lines = textOf(root).split('\n')
  // Start from the product's own title where it can be found.
  const at = lines.findIndex((l) => l.trim().toLowerCase() === title.trim().toLowerCase())
  if (at > 0) lines = lines.slice(at)
  const facts = factsFromLines(lines)
  return { colour: colour ?? facts.colour, composition: composition ?? facts.composition, madeIn: facts.madeIn }
}
