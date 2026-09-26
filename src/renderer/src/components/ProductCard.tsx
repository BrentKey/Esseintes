import { useState } from 'react'
import type { Product } from '@shared/types'
import { useData } from '../data'
import { api, bestSitewidePromo, discountPercent, isRecent, sized } from '../lib'
import { useNav } from '../nav'
import { Heart } from './Icons'
import { Price } from './Price'

export function ProductCard({ product, onFavorite, note }: { product: Product; onFavorite?: (fav: boolean) => void; note?: string }) {
  const { go } = useNav()
  const { promotions, bump } = useData()
  const [fav, setFav] = useState(product.favorite)
  const [hover, setHover] = useState(false)
  const pct = discountPercent(product)
  const promo = bestSitewidePromo(promotions, product.storeId)
  const reduced = isRecent(product.priceDroppedAt, 14)
  const isNew = isRecent(product.firstSeenAt, 7)
  const img = hover && product.images[1] ? product.images[1] : product.images[0]

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    const next = await api.toggleFavorite(product.id)
    setFav(next)
    onFavorite?.(next)
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
          {!reduced && !pct && isNew && <span className="badge">New</span>}
          {promo && <span className="badge badge-promo">Extra {promo.percent}%</span>}
        </div>
      </div>
      <div className="card-body">
        {note && <div className="card-note">{note}</div>}
        <div className="card-brand">{product.brand}</div>
        <div className="card-title">{product.title}</div>
        <Price product={product} promo={promo} compact />
        {product.storeName !== product.brand && <div className="card-store">{product.storeName}</div>}
      </div>
    </article>
  )
}

export function ProductGrid({ products, onFavorite }: { products: Product[]; onFavorite?: (p: Product, fav: boolean) => void }) {
  return (
    <div className="grid">
      {products.map((p) => (
        <ProductCard key={p.id} product={p} onFavorite={(f) => onFavorite?.(p, f)} />
      ))}
    </div>
  )
}
