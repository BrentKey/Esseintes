import { useEffect, useState } from 'react'
import type { ModelColourway, Product as P, ProductDetail } from '@shared/types'
import { External, Heart } from '../components/Icons'
import { Price } from '../components/Price'
import { Lightbox } from '../components/Lightbox'
import { ProductGrid } from '../components/ProductCard'
import { useData } from '../data'
import { api, bestSitewidePromo, compareSizes, looksForeign, money, sized, translateUrl } from '../lib'
import { useNav } from '../nav'

export function Product({ id }: { id: string }) {
  const { go, back } = useNav()
  const { settings, updateSettings, bump } = useData()
  const [p, setP] = useState<ProductDetail | null>(null)
  const [model, setModel] = useState<ModelColourway[]>([])
  const [sel, setSel] = useState(0)
  const [more, setMore] = useState<P[]>([])
  const [img, setImg] = useState(0)
  const [size, setSize] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    setImg(0)
    api.getProduct(id).then((d) => {
      setP(d)
      if (!d) return
      setModel(d.model)
      setSize(d.favoriteSize)
      // Open on the colour that was clicked (a newly added colour, if that's why it was shown).
      const i = d.model.findIndex((c) => c.productId === d.id && (!d.newColor || c.name === d.newColor))
      setSel(Math.max(0, i))
      api.queryProducts({ brands: [d.brand], limit: 9, facets: 'none' }).then((r) => setMore(r.items.filter((x) => x.id !== d.id).slice(0, 8)))
    })
  }, [id])

  if (!p) return null
  const promo = bestSitewidePromo(p.promotions, p.storeId)
  const sizes = [...p.sizes].sort((a, b) => compareSizes(a.label, b.label))
  const mine = new Set(settings.mySizes.map((s) => s.toUpperCase()))
  const colour = model[sel]
  const gallery = colour?.productId === p.id && colour.images.length ? colour.images : p.images

  async function pickColour(i: number) {
    const c = model[i]
    setSel(i)
    setImg(0)
    // Colours listed separately by the store are their own products: load that one.
    if (c.productId !== p!.id) {
      const d = await api.getProduct(c.productId)
      if (d) {
        setP(d)
        setSize(d.favoriteSize)
      }
    }
  }

  async function pickSize(label: string) {
    const next = size === label ? null : label
    setSize(next)
    if (p!.favorite) {
      await api.saveFavorite(p!.id, next)
      bump()
    }
  }

  async function toggleSaved() {
    if (p!.favorite) await api.toggleFavorite(p!.id)
    else await api.saveFavorite(p!.id, size)
    setP({ ...p!, favorite: !p!.favorite, favoriteSize: p!.favorite ? null : size })
    bump()
  }

  return (
    <div className="page product">
      <div className="product-main">
        <div className="gallery">
          <div className="thumbs">
            {gallery.slice(0, 10).map((src, i) => (
              <button key={src} className={i === img ? 'on' : ''} onClick={() => setImg(i)}>
                <img src={sized(src, 160)} alt="" />
              </button>
            ))}
          </div>
          <div className="gallery-main">
            {gallery[img] && (
              <button onClick={() => setZoomed(true)} aria-label="Enlarge photo">
                <img src={sized(gallery[img], 1400)} alt={p.title} />
              </button>
            )}
          </div>
        </div>
        {zoomed && <Lightbox images={gallery.slice(0, 10)} start={img} alt={p.title} onClose={() => setZoomed(false)} />}

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

          {model.length > 1 && (
            <div className="sizes">
              <div className="sizes-head">
                {model.length} colours{colour?.name ? `: ${colour.name}` : ''}
              </div>
              <div className="color-grid">
                {model.map((c, i) => (
                  <button
                    key={`${c.productId}:${c.name ?? i}`}
                    className={`color ${c.available ? '' : 'out'} ${i === sel ? 'on' : ''}`}
                    title={`${c.name ?? `Colour ${i + 1}`}${c.available ? '' : ' (sold out)'}${c.isNew ? ' · new' : ''}`}
                    onClick={() => pickColour(i)}
                  >
                    {c.image ? <img src={sized(c.image, 160)} alt="" /> : <span>{c.name}</span>}
                    {c.isNew && <i className="color-new" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {sizes.length > 0 && (
            <div className="sizes">
              <div className="sizes-head">
                Sizes at {p.storeName}
                <span className="muted sizes-hint">
                  {size ? (p.favorite ? `Tracking size ${size}` : `Size ${size} selected`) : 'Pick your size to track it'}
                </span>
              </div>
              <div className="size-grid">
                {sizes.map((s) => (
                  <button
                    key={s.label}
                    className={`size ${s.available ? '' : 'out'} ${mine.has(s.label.toUpperCase()) ? 'mine' : ''} ${size === s.label ? 'picked' : ''}`}
                    title={s.available ? 'In stock' : 'Sold out: save it to hear when it’s back'}
                    onClick={() => pickSize(s.label)}
                  >
                    {s.label}
                  </button>
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
              onClick={toggleSaved}
              title={p.favorite ? 'Remove from the collection' : size ? `Save in size ${size}` : 'Save to the collection'}
              aria-label="Add to the collection"
            >
              <Heart filled={p.favorite} />
            </button>
          </div>

          {p.description && (
            <details className="details" open>
              <summary>Details</summary>
              <div className="description">{p.description}</div>
              {looksForeign(p.description) && (
                <button className="link small translate" onClick={() => api.openExternal(translateUrl(p.url))}>
                  Read in English ↗
                </button>
              )}
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
