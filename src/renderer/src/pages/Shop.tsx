import { useCallback, useEffect, useRef, useState } from 'react'
import type { Facet, Product, ProductPage, ProductQuery, SortKey } from '@shared/types'
import { ProductGrid } from '../components/ProductCard'
import { useData, useLiveVersion } from '../data'
import { api, compareSizes } from '../lib'

const PAGE = 60

interface Filters {
  categories: string[]
  storeIds: number[]
  brands: string[]
  sizes: string[]
  onSale: boolean
  inMySize: boolean
  sort: SortKey
  minPrice?: number
  maxPrice?: number
}

export function Shop({ title, subtitle, query }: { title: string; subtitle?: string; query: ProductQuery }) {
  const { settings } = useData()
  const version = useLiveVersion()
  const [filters, setFilters] = useState<Filters>({
    categories: [],
    storeIds: [],
    brands: [],
    sizes: [],
    onSale: !!query.onSale,
    inMySize: false,
    sort: query.sort ?? 'newest'
  })
  const [page, setPage] = useState<ProductPage | null>(null)
  const [items, setItems] = useState<Product[]>([])
  const favoritesOnly = !!query.favoritesOnly
  // Stable, so memoized cards don't re-render when this page does.
  const onFavorite = useCallback(
    (p: Product, fav: boolean) => {
      if (favoritesOnly && !fav) setItems((xs) => xs.filter((x) => x.id !== p.id))
    },
    [favoritesOnly]
  )
  const [loadingMore, setLoadingMore] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)
  const loaded = useRef({ key: '', count: 0 })

  const effective: ProductQuery = {
    ...query,
    categories: filters.categories.length ? filters.categories : query.categories,
    storeIds: filters.storeIds.length ? filters.storeIds : query.storeIds,
    brands: filters.brands.length ? filters.brands : query.brands,
    sizes: filters.sizes,
    onSale: filters.onSale || undefined,
    inMySize: filters.inMySize || undefined,
    sort: filters.sort,
    minPrice: filters.minPrice,
    maxPrice: filters.maxPrice
  }
  const key = JSON.stringify(effective)

  useEffect(() => {
    let cancelled = false
    // A background refresh keeps however many items were already scrolled into view.
    const limit = loaded.current.key === key ? Math.max(PAGE, loaded.current.count) : PAGE
    api.queryProducts({ ...effective, limit, offset: 0 }).then((r) => {
      if (cancelled) return
      loaded.current = { key, count: r.items.length }
      setPage(r)
      setItems(r.items)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, settings.gender, settings.onlyMySizes, settings.mySizes, settings.includeUnknownGender])

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current
    if (!el || !page || items.length >= page.total) return
    const io = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting || loadingMore) return
      setLoadingMore(true)
      const r = await api.queryProducts({ ...effective, limit: PAGE, offset: items.length, facets: 'none' })
      setItems((prev) => {
        const next = [...prev, ...r.items]
        loaded.current.count = next.length
        return next
      })
      setLoadingMore(false)
    }, { rootMargin: '800px' })
    io.observe(el)
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, items.length, loadingMore, key])

  const toggle = <K extends 'categories' | 'storeIds' | 'brands' | 'sizes'>(k: K, v: Filters[K][number]) =>
    setFilters((f) => {
      const list = f[k] as any[]
      return { ...f, [k]: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] }
    })

  const categoryFacets = page?.facets.categories.filter((c) => !query.categories || query.categories.includes(c.value)) ?? []
  const activeCount = filters.categories.length + filters.storeIds.length + filters.brands.length + filters.sizes.length + (filters.minPrice != null || filters.maxPrice != null ? 1 : 0)

  return (
    <div className="page shop">
      <div className="shop-head">
        <div>
          {subtitle && <div className="eyebrow">{subtitle}</div>}
          <h1 className="display">{title}</h1>
          <div className="muted">{page ? `${page.total.toLocaleString()} ${page.total === 1 ? 'piece' : 'pieces'}` : ' '}</div>
        </div>
        <div className="shop-controls">
          {query.favoritesOnly && (
            <label className="toggle" title="In stock in the size you saved (or your sizes, if none was saved)">
              <input type="checkbox" checked={filters.inMySize} onChange={(e) => setFilters({ ...filters, inMySize: e.target.checked })} />
              Available in my size
            </label>
          )}
          {!query.onSale && (
            <label className="toggle">
              <input type="checkbox" checked={filters.onSale} onChange={(e) => setFilters({ ...filters, onSale: e.target.checked })} />
              On sale
            </label>
          )}
          <select value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value as SortKey })}>
            <option value="newest">Newest</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
            <option value="discount">Biggest discount</option>
          </select>
        </div>
      </div>

      <div className="shop-body">
        <aside className="filters">
          {activeCount > 0 && (
            <button className="link" onClick={() => setFilters({ ...filters, categories: [], storeIds: [], brands: [], sizes: [], minPrice: undefined, maxPrice: undefined })}>
              Clear all filters ({activeCount})
            </button>
          )}
          {categoryFacets.length > 1 && (
            <FacetGroup title="Category" facets={categoryFacets} selected={filters.categories} onToggle={(v) => toggle('categories', v)} />
          )}
          {!query.storeIds && page && page.facets.stores.length > 1 && (
            <FacetGroup title="Store" facets={page.facets.stores} selected={filters.storeIds.map(String)} onToggle={(v) => toggle('storeIds', Number(v))} />
          )}
          {page && page.facets.brands.length > 1 && (
            <FacetGroup title="Designer" facets={page.facets.brands} selected={filters.brands} onToggle={(v) => toggle('brands', v)} searchable />
          )}
          {page && page.facets.sizes.length > 0 && (
            <FacetGroup
              title="Size"
              facets={[...page.facets.sizes].sort((a, b) => compareSizes(a.value, b.value))}
              selected={filters.sizes}
              onToggle={(v) => toggle('sizes', v)}
              chips
            />
          )}
          <div className="facet">
            <div className="facet-title">Price</div>
            <div className="price-range">
              <input
                type="number"
                placeholder="Min"
                value={filters.minPrice ?? ''}
                onChange={(e) => setFilters({ ...filters, minPrice: e.target.value ? Number(e.target.value) : undefined })}
              />
              <span>–</span>
              <input
                type="number"
                placeholder="Max"
                value={filters.maxPrice ?? ''}
                onChange={(e) => setFilters({ ...filters, maxPrice: e.target.value ? Number(e.target.value) : undefined })}
              />
            </div>
          </div>
        </aside>

        <div className="shop-results">
          {page && items.length === 0 ? (
            <div className="empty-inline">
              {query.favoritesOnly ? (
                <>
                  <p className="display small-display">The collection is empty</p>
                  <p className="muted">Save the pieces worth keeping with the ♡ and they’ll wait for you here.</p>
                </>
              ) : (
                <>
                  <p className="display small-display">Nothing here meets the standard</p>
                  <p className="muted">Try loosening a filter or two.</p>
                </>
              )}
              {settings.onlyMySizes && <p className="muted small">“Only show my sizes” is on in Settings.</p>}
            </div>
          ) : (
            <ProductGrid
              products={items}
              showSaved={query.favoritesOnly}
              onFavorite={onFavorite}
            />
          )}
          <div ref={sentinel} className="sentinel" />
        </div>
      </div>
    </div>
  )
}

function FacetGroup({
  title,
  facets,
  selected,
  onToggle,
  searchable,
  chips
}: {
  title: string
  facets: Facet[]
  selected: string[]
  onToggle: (v: string) => void
  searchable?: boolean
  chips?: boolean
}) {
  const [open, setOpen] = useState(true)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState(false)
  const shown = facets.filter((f) => !filter || f.label.toLowerCase().includes(filter.toLowerCase()))
  const limit = chips ? 40 : 12
  const visible = expanded ? shown : shown.slice(0, limit)

  return (
    <div className="facet">
      <button className="facet-title" onClick={() => setOpen(!open)}>
        {title}
        <span>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <>
          {searchable && facets.length > 12 && (
            <input className="facet-search" placeholder={`Search ${title.toLowerCase()}s`} value={filter} onChange={(e) => setFilter(e.target.value)} />
          )}
          <div className={chips ? 'facet-chips' : 'facet-list'}>
            {visible.map((f) =>
              chips ? (
                <button key={f.value} className={`chip ${selected.includes(f.value) ? 'on' : ''}`} onClick={() => onToggle(f.value)}>
                  {f.label}
                </button>
              ) : (
                <label key={f.value} className="facet-option">
                  <input type="checkbox" checked={selected.includes(f.value)} onChange={() => onToggle(f.value)} />
                  <span>{f.label}</span>
                  <span className="muted">{f.count}</span>
                </label>
              )
            )}
          </div>
          {shown.length > limit && (
            <button className="link small" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : `Show all ${shown.length}`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
