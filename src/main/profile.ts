import { departmentOf } from '@shared/categories'
import type { Gender, StoreProfile } from '@shared/types'

/** Bump when the rules below change, so the next sync may retire what the old ones kept. */
export const PROFILE_VERSION = 1

// A store "has" men's or women's sections once they hold this many items; fewer
// is a gift guide or a one-off edit, not a department.
const MIN_SECTION_ITEMS = 5

export interface ProfileItem {
  /** Gender from the product's own words and sections (see classifyGender). */
  gender: Gender
  category: string
  /** Which of the store's men's/women's sections the item was found in. */
  section: Gender | null
}

/**
 * Decides how a store is read and settles the items its sections and words
 * leave unlabelled. The most reliable signal wins:
 *
 * 1. The store's own men's and women's sections, found by name or by the menu
 *    heading they sit under, are applied by the store's reader. Here, a store
 *    whose men's section holds nearly everything and that has no women's side
 *    is signalling that the clothing and shoes left outside it are womenswear.
 *    Items outside every section otherwise stay unlabelled: at stores divided
 *    both ways they're usually unisex (eyewear, accessories, home goods).
 * 2. A store whose labelled items are almost all one gender sells to that
 *    gender; its unlabelled items follow.
 * 3. Otherwise only each product's own words, which are already applied.
 *
 * Mutates `gender` on the items it settles.
 */
export function profileStore(items: ProfileItem[], notForSale: number): StoreProfile {
  const count = (s: Gender) => items.filter((i) => i.section === s).length
  const inMen = count('men')
  const inWomen = count('women')
  const inBoth = count('unisex')
  const inNeither = items.length - inMen - inWomen - inBoth
  const hasMen = inMen + inBoth >= MIN_SECTION_ITEMS
  const hasWomen = inWomen + inBoth >= MIN_SECTION_ITEMS

  const menDepartments = hasMen && inWomen + inBoth === 0 && (inMen + inBoth) / Math.max(1, items.length) >= 0.85 ? ['Clothing', 'Shoes'] : []
  for (const i of items)
    if (i.gender === 'unknown' && !i.section && menDepartments.includes(departmentOf(i.category))) i.gender = 'women'

  const storeGender = inferStoreGender(items.map((i) => i.gender))
  if (storeGender) for (const i of items) if (i.gender === 'unknown') i.gender = storeGender

  return {
    version: PROFILE_VERSION,
    source: hasMen || hasWomen ? 'sections' : storeGender ? 'single' : 'words',
    inMen,
    inWomen,
    inBoth,
    inNeither,
    menDepartments,
    storeGender,
    notForSale
  }
}

/**
 * A store whose labelled items are overwhelmingly one gender (a menswear
 * brand, say) is treated as that gender for items it doesn't label.
 */
function inferStoreGender(genders: string[]): 'men' | 'women' | null {
  const men = genders.filter((g) => g === 'men').length
  const women = genders.filter((g) => g === 'women').length
  const labelled = men + women
  // A handful of labelled items isn't enough to judge a whole store (Our Legacy
  // labelled a few women's pieces and left its menswear unmarked).
  if (labelled < Math.max(5, genders.length * 0.3)) return null
  if (men / labelled >= 0.9) return 'men'
  if (women / labelled >= 0.9) return 'women'
  return null
}
