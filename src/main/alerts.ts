import type { AlertKind, Size } from '@shared/types'
import { sizeMatches } from './classify'

export interface NewAlert {
  productId: string
  kind: AlertKind
  message: string
}

interface Before {
  price: number
  sizes: string
  available: number
}

interface After {
  id: string
  price: number
  currency: string
  sizes: Size[]
  available: boolean
}

/** In-stock sizes the user cares about; with no saved sizes, any size counts. */
function wantedInStock(sizes: Size[], mySizes: string[]): string[] {
  return sizes.filter((s) => s.available && (!mySizes.length || sizeMatches(s.label, mySizes))).map((s) => s.label)
}

/** Compares a wishlist item before and after a sync and describes anything worth telling the user. */
export function wishlistAlerts(
  before: Before,
  after: After,
  mySizes: string[],
  money: (amount: number, currency: string) => string
): NewAlert[] {
  const alerts: NewAlert[] = []

  // 5%+ only: smaller moves are usually a store's automatic currency conversion.
  if (after.price <= before.price * 0.95) {
    const pct = Math.round((1 - after.price / before.price) * 100)
    alerts.push({
      productId: after.id,
      kind: 'price-drop',
      message: `Now ${money(after.price, after.currency)}, down ${pct}% from ${money(before.price, after.currency)}`
    })
  }

  const prevSizes: Size[] = JSON.parse(before.sizes || '[]')
  if (after.sizes.length) {
    const had = new Set(wantedInStock(prevSizes, mySizes))
    const restocked = wantedInStock(after.sizes, mySizes).filter((s) => !had.has(s))
    // Only a restock if the size was listed before (brand-new sizes aren't "back").
    const listedBefore = new Set(prevSizes.map((s) => s.label))
    const back = restocked.filter((s) => listedBefore.has(s))
    if (back.length) {
      alerts.push({
        productId: after.id,
        kind: 'back-in-stock',
        message: `Back in stock in ${mySizes.length ? 'your size' : 'size'} ${back.join(', ')}`
      })
    }
  } else if (!before.available && after.available) {
    alerts.push({ productId: after.id, kind: 'back-in-stock', message: 'Back in stock' })
  }

  return alerts
}
