import { useEffect, useState } from 'react'
import type { Alert, HomeData } from '@shared/types'
import { ProductCard, ProductGrid } from '../components/ProductCard'
import { useData } from '../data'
import { api, sized, timeAgo } from '../lib'
import { useNav } from '../nav'

export function Home() {
  const { go } = useNav()
  const { version, settings, sync } = useData()
  const [data, setData] = useState<HomeData | null>(null)

  useEffect(() => {
    api.getHome().then(setData)
  }, [version, settings.gender, settings.onlyMySizes, settings.mySizes])

  if (!data) return null
  const empty = data.newIn.length === 0
  // The hero shows three different stores; the What's New row carries on from there without repeating them.
  const heroImages: typeof data.newIn = []
  for (const p of data.newIn) if (heroImages.length < 3 && !heroImages.some((h) => h.storeId === p.storeId)) heroImages.push(p)
  for (const p of data.newIn) if (heroImages.length < 3 && !heroImages.includes(p)) heroImages.push(p)
  const whatsNew = data.newIn.filter((p) => !heroImages.includes(p)).slice(0, 8)

  if (empty) {
    return (
      <div className="page empty-state">
        <h1 className="display">{sync.running ? 'Sending for the latest pieces…' : data.stores.length ? 'Nothing meets the standard' : 'An empty study'}</h1>
        <p className="muted">
          {sync.running
            ? `Reading ${sync.currentStore ?? 'your stores'} (${sync.completed}/${sync.total}). This takes a minute the first time.`
            : data.stores.length
              ? 'No items match your department and size settings.'
              : 'Add the stores you love and Esseintes will gather everything they sell into one place.'}
        </p>
        {!sync.running && (
          <button className="btn" onClick={() => go({ page: data.stores.length ? 'settings' : 'stores' })}>
            {data.stores.length ? 'Review settings' : 'Add stores'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="page home">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">{data.newSinceLastVisit > 0 ? 'Since your last visit' : 'This week'}</div>
          <h1 className="display">
            {data.newSinceLastVisit > 0 ? `${data.newSinceLastVisit} new arrivals` : 'The latest arrivals'}
          </h1>
          <p className="muted">
            Fresh from {data.stores.length} {data.stores.length === 1 ? 'store' : 'stores'}. Last updated {timeAgo(sync.lastRunAt ?? latest(data))}.
          </p>
          <div className="hero-actions">
            <button
              className="btn"
              onClick={() =>
                go(
                  data.newSinceLastVisit > 0
                    ? { page: 'shop', title: 'New Since Your Last Visit', query: { newSince: data.previousVisitAt ?? undefined } }
                    : { page: 'shop', title: "What's New", query: { sort: 'newest', individual: true } }
                )
              }
            >
              Shop new in
            </button>
            {data.saleCount > 0 && (
              <button className="btn btn-outline" onClick={() => go({ page: 'shop', title: 'Sale', query: { onSale: true, sort: 'discount' } })}>
                Sale · {data.saleCount}
              </button>
            )}
          </div>
        </div>
        <div className="hero-images">
          {heroImages.map((p) => (
            <button key={p.id} onClick={() => go({ page: 'product', id: p.id })}>
              <img src={sized(p.images[0], 800)} alt={p.title} />
            </button>
          ))}
        </div>
      </section>

      {data.alerts.length > 0 && (
        <section className="section">
          <SectionHead title="News from the Collection" action="View the collection" onAction={() => go({ page: 'shop', title: 'The Collection', query: { favoritesOnly: true } })} />
          <div className="grid">
            {dedupeAlerts(data.alerts).slice(0, 8).map((a) => (
              <ProductCard key={a.id} product={a.product} note={`${a.message} · ${timeAgo(a.createdAt)}`} />
            ))}
          </div>
        </section>
      )}

      {data.promotions.length > 0 && (
        <section className="section">
          <SectionHead title="Sales & Offers" />
          <div className="promo-grid">
            {data.promotions.map((p) => (
              <button
                key={p.id}
                className="promo-card"
                onClick={() => go({ page: 'shop', title: p.storeName, query: { storeIds: [p.storeId] }, subtitle: p.text })}
              >
                <div className="promo-store">{p.storeName}</div>
                {p.percent ? <div className="promo-pct">{p.percent}% off</div> : null}
                <div className="promo-text">{p.text}</div>
                {p.code && <div className="promo-code">Code {p.code}</div>}
                <div className="promo-meta">{p.sitewide ? 'Store-wide' : 'Selected items'} · spotted {timeAgo(p.firstSeenAt)}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <SectionHead title="What’s New" action="Shop all" onAction={() => go({ page: 'shop', title: "What's New", query: { sort: 'newest', individual: true } })} />
        <ProductGrid products={whatsNew} />
      </section>

      {data.justReduced.length > 0 && (
        <section className="section">
          <SectionHead
            title="Just Reduced"
            action="Shop all"
            onAction={() => go({ page: 'shop', title: 'Just Reduced', query: { justReduced: true }, subtitle: 'Price drops from the last two weeks' })}
          />
          <ProductGrid products={data.justReduced.slice(0, 8)} />
        </section>
      )}

      <section className="section">
        <SectionHead title="Shop by Category" />
        <div className="category-grid">
          {data.categories.map((c) => (
            <button key={c.name} className="category-tile" onClick={() => go({ page: 'shop', title: c.name, query: { categories: [c.name] } })}>
              <div className="category-img">{c.image && <img src={sized(c.image, 500)} alt="" loading="lazy" />}</div>
              <div className="category-name">{c.name}</div>
              <div className="muted small">{c.count} pieces</div>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <SectionHead title="Your Stores" action="Manage" onAction={() => go({ page: 'stores' })} />
        <div className="store-list">
          {data.stores.map((s) => (
            <button key={s.id} onClick={() => go({ page: 'shop', title: s.name, query: { storeIds: [s.id] } })}>
              <span className="store-name">{s.name}</span>
              <span className="muted small">{s.productCount} pieces</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

/** Newest alert per product, so one item doesn't fill the row. */
function dedupeAlerts(alerts: Alert[]): Alert[] {
  const seen = new Set<string>()
  return alerts.filter((a) => !seen.has(a.product.id) && seen.add(a.product.id))
}

function latest(d: HomeData): string | null {
  return d.stores.map((s) => s.lastSyncedAt).filter(Boolean).sort().pop() ?? null
}

function SectionHead({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {action && (
        <button className="link" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  )
}
