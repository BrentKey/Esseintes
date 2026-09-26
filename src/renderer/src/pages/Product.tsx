import { useEffect, useState } from 'react'
import type { Product as P, ProductDetail } from '@shared/types'
import { External, Heart } from '../components/Icons'
import { Price } from '../components/Price'
import { ProductGrid } from '../components/ProductCard'
import { useData } from '../data'
import { api, bestSitewidePromo, compareSizes, money, sized } from '../lib'
import { useNav } from '../nav'

export function Product({ id }: { id: string }) {
  const { go, back } = useNav()
  const { settings, updateSettings, bump } = useData()
  const [p, setP] = useState<ProductDetail | null>(null)
  const [more, setMore] = useState<P[]>([])
  const [img, setImg] = useState(0)

  useEffect(() => {
    setImg(0)
    api.getProduct(id).then((d) => {
      setP(d)
      if (d)
        api.queryProducts({ brands: [d.brand], limit: 9 }).then((r) => setMore(r.items.filter((x) => x.id !== d.id).slice(0, 8)))
    })
  }, [id])

  if (!p) return null
  const promo = bestSitewidePromo(p.promotions, p.storeId)
  const sizes = [...p.sizes].sort((a, b) => compareSizes(a.label, b.label))
  const mine = new Set(settings.mySizes.map((s) => s.toUpperCase()))

  return (
    <div className="page product">
      <div className="product-main">
        <div className="gallery">
          <div className="thumbs">
            {p.images.slice(0, 10).map((src, i) => (
              <button key={src} className={i === img ? 'on' : ''} onClick={() => setImg(i)}>
                <img src={sized(src, 160)} alt="" />
              </button>
            ))}
          </div>
          <div className="gallery-main">{p.images[img] && <img src={sized(p.images[img], 1400)} alt={p.title} />}</div>
        </div>

        <div className="product-info">
          <button className="product-brand" onClick={() => go({ page: 'shop', title: p.brand, query: { brands: [p.brand] } })}>
            {p.brand}
          </button>
          <h1 className="product-title">{p.title}</h1>
          <Price product={p} />

          {!p.available && <div className="notice">Sold out at {p.storeName}</div>}

          {p.promotions.length > 0 && (
            <div className="notice notice-promo">
              {p.promotions.map((pr) => (
                <div key={pr.id}>
                  <strong>{p.storeName}:</strong> {pr.text}
                  {pr.code && !pr.text.includes(pr.code) && <> · Code <code>{pr.code}</code></>}
                </div>
              ))}
              {promo && (
                <div className="muted small">
                  Estimated {money(p.price * (1 - promo.percent! / 100), p.currency)} after {promo.percent}% off. Check exclusions at checkout.
                </div>
              )}
            </div>
          )}

          {sizes.length > 0 && (
            <div className="sizes">
              <div className="sizes-head">Sizes at {p.storeName}</div>
              <div className="size-grid">
                {sizes.map((s) => (
                  <span
                    key={s.label}
                    className={`size ${s.available ? '' : 'out'} ${mine.has(s.label.toUpperCase()) ? 'mine' : ''}`}
                    title={s.available ? 'In stock' : 'Sold out'}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="product-actions">
            <button className="btn btn-wide" onClick={() => api.openExternal(p.url)}>
              Shop at {p.storeName} <External />
            </button>
            <button
              className={`btn btn-outline btn-icon ${p.favorite ? 'on' : ''}`}
              onClick={async () => {
                const favorite = await api.toggleFavorite(p.id)
                setP({ ...p, favorite })
                bump()
              }}
              aria-label="Add to the collection"
            >
              <Heart filled={p.favorite} />
            </button>
          </div>

          {p.description && (
            <details className="details" open>
              <summary>Details</summary>
              <div className="description">{p.description}</div>
            </details>
          )}

          <details className="details" open={p.priceHistory.length > 1}>
            <summary>Price history</summary>
            <PriceHistory product={p} />
          </details>

          <div className="muted small meta">
            {p.category} · first spotted {new Date(p.firstSeenAt).toLocaleDateString()}
            <div className="hide-links">
              Not for you?{' '}
              <button
                className="link small"
                onClick={async () => {
                  await updateSettings({ hiddenBrands: [...new Set([...settings.hiddenBrands, p.brand])] })
                  back()
                }}
              >
                Hide {p.brand}
              </button>
              {' · '}
              <button
                className="link small"
                onClick={async () => {
                  await updateSettings({ hiddenCategories: [...new Set([...settings.hiddenCategories, p.category])] })
                  back()
                }}
              >
                Hide all {p.category}
              </button>
            </div>
          </div>
        </div>
      </div>

      {more.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>More from {p.brand}</h2>
          </div>
          <ProductGrid products={more} />
        </section>
      )}
    </div>
  )
}

function PriceHistory({ product }: { product: ProductDetail }) {
  const h = product.priceHistory
  if (h.length < 2) return <p className="muted small">No price changes since this item was first spotted.</p>
  const pts = [...h, { ...h[h.length - 1], recordedAt: new Date().toISOString() }]
  const t0 = new Date(pts[0].recordedAt).getTime()
  const t1 = new Date(pts[pts.length - 1].recordedAt).getTime()
  const prices = pts.map((p) => p.price)
  const lo = Math.min(...prices) * 0.95
  const hi = Math.max(...prices) * 1.05
  const W = 400
  const H = 120
  const x = (t: string) => ((new Date(t).getTime() - t0) / Math.max(1, t1 - t0)) * W
  const y = (v: number) => H - ((v - lo) / Math.max(0.01, hi - lo)) * H
  // Step line: a price holds until the next change.
  let d = `M0 ${y(pts[0].price)}`
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].recordedAt)} V${y(pts[i].price)}`
  return (
    <div className="history">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <ul>
        {[...h].reverse().map((p) => (
          <li key={p.recordedAt}>
            <span>{new Date(p.recordedAt).toLocaleDateString()}</span>
            <span>{money(p.price, product.currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
