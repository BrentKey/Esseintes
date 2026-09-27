import { memo, useState } from 'react'
import type { Product } from '@shared/types'
import { useData } from '../data'
import { api, bestSitewidePromo, discountPercent, isRecent, sized } from '../lib'
import { useNav } from '../nav'
import { Heart } from './Icons'
import { Price } from './Price'

// Memoized: long grids re-render often (loading more, hover), and each card is cheap to skip.
export const ProductCard = memo(function ProductCard({
  product,
  onFavorite,
  note,
  showSaved
}: {
  product: Product
  onFavorite?: (p: Product, fav: boolean) => void
  note?: string
  /** In the collection, show the saved size and whether it's in stock. */
  showSaved?: boolean
}) {
  const { go } = useNav()
  const { promotions, bump } = useData()
  const [fav, setFav] = useState(product.favorite)
  const [hover, setHover] = useState(false)
  const pct = discountPercent(product)
  const promo = bestSitewidePromo(promotions, product.storeId)
  const reduced = isRecent(product.priceDroppedAt, 14)
  const isNew = product.isNew
  // A card for a newly added colour leads with that colour's photo.
  const lead = (product.newColor && product.colors.find((c) => c.name === product.newColor)?.image) || product.images[0]
  const img = hover && product.images[1] ? product.images[1] : lead
  const savedSize = showSaved && product.favoriteSize ? product.sizes.find((s) => s.label === product.favoriteSize) : null

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    const next = await api.toggleFavorite(product.id)
    setFav(next)
    onFavorite?.(product, next)
    bump()
  }

  return (
    <article
      className="card"
      onClick={() => go({ page: 'product', id: product.id })}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="card-media">
        {img ? <img src={sized(img, 600)} alt={product.title} loading="lazy" /> : <div className="card-noimg">No image</div>}
        <button className={`card-fav ${fav ? 'on' : ''}`} onClick={toggle} aria-label="Add to the collection">
          <Heart filled={fav} />
        </button>
        <div className="card-badges">
          {reduced ? <span className="badge badge-sale">Just reduced</span> : pct ? <span className="badge badge-sale">−{pct}%</span> : null}
          {!reduced && !pct && isNew && <span className="badge">{product.newColor ? 'New colour' : 'New'}</span>}
          {promo && <span className="badge badge-promo">Extra {promo.percent}%</span>}
        </div>
      </div>
      <div className="card-body">
        {note && <div className="card-note">{note}</div>}
        <div className="card-brand">{product.brand}</div>
        <div className="card-title">{product.title}</div>
        <Price product={product} promo={promo} compact />
        {savedSize && (
          <div className={`card-saved ${savedSize.available && product.available ? 'in' : 'out'}`}>
            Size {savedSize.label} · {savedSize.available && product.available ? 'in stock' : 'sold out'}
          </div>
        )}
        {(product.storeName !== product.brand || product.colourCount > 1) && (
          <div className="card-store">
            {[product.storeName !== product.brand && product.storeName, product.colourCount > 1 && `${product.colourCount} colours`]
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}
      </div>
    </article>
  )
})

export function ProductGrid({
  products,
  onFavorite,
  showSaved
}: {
  products: Product[]
  onFavorite?: (p: Product, fav: boolean) => void
  showSaved?: boolean
}) {
  return (
    <div className="grid">
      {products.map((p) => (
        <ProductCard key={p.id} product={p} onFavorite={onFavorite} showSaved={showSaved} />
      ))}
    </div>
  )
}
