import type { Product, Promotion } from '@shared/types'
import { discountPercent, money } from '../lib'

export function Price({ product, promo, compact }: { product: Product; promo?: Promotion | null; compact?: boolean }) {
  const pct = discountPercent(product)
  const was = product.compareAtPrice ?? (product.previousPrice && product.previousPrice > product.price ? product.previousPrice : null)
  return (
    <div className={`price ${compact ? 'price-compact' : ''}`}>
      {was ? (
        <>
          <span className="price-now sale">{money(product.price, product.currency)}</span>
          <span className="price-was">{money(was, product.currency)}</span>
          {pct && !compact && <span className="price-pct">{pct}% off</span>}
        </>
      ) : (
        <span className="price-now">{money(product.price, product.currency)}</span>
      )}
      {!compact && product.originalCurrency && product.originalPrice != null && (
        <span className="price-original">{money(product.originalPrice, product.originalCurrency)} at store</span>
      )}
      {promo?.percent && (
        <div className="price-promo">
          {money(product.price * (1 - promo.percent / 100), product.currency)} with {promo.code ? `code ${promo.code}` : 'store sale'}
        </div>
      )}
    </div>
  )
}
