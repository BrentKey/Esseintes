import { useEffect, useState } from 'react'
import type { Facet } from '@shared/types'
import { DEPARTMENTS } from '@shared/categories'
import { useData } from '../data'
import { api, timeAgo } from '../lib'
import { useNav } from '../nav'
import tortoise from '../assets/tortoise.svg'
import { Back, Cog, Heart, Refresh, Search, Store } from './Icons'

// Departments that get their own top-level link, each with a dropdown of its categories.
const NAV_DEPARTMENTS = ['Clothing', 'Shoes', 'Bags', 'Accessories', 'Lifestyle']

export function Header() {
  const { go, back, canGoBack, route } = useNav()
  const { sync, version, unreadAlerts, bump } = useData()
  const [search, setSearch] = useState('')
  const [counts, setCounts] = useState<Map<string, number>>(new Map())
  const [menu, setMenu] = useState<string | null>(null)

  useEffect(() => {
    api.queryProducts({ limit: 0 }).then((r) => setCounts(new Map(r.facets.categories.map((c: Facet) => [c.value, c.count]))))
  }, [version])

  const shop = (title: string, query = {}, subtitle?: string) => {
    setMenu(null)
    go({ page: 'shop', title, query, subtitle })
  }
  // Only departments/categories that currently have items.
  const departments = DEPARTMENTS.filter((d) => NAV_DEPARTMENTS.includes(d.name))
    .map((d) => ({ ...d, categories: d.categories.filter((c) => counts.get(c)) }))
    .filter((d) => d.categories.length)
  const open = departments.find((d) => d.name === menu)

  return (
    <header className="header">
      <div className="header-top drag">
        <div className="header-left no-drag">
          {canGoBack && route.page !== 'home' && (
            <button className="icon-btn" onClick={back} aria-label="Back">
              <Back />
            </button>
          )}
        </div>

        <button className="brand no-drag" onClick={() => go({ page: 'home' })}>
          <span className="wordmark">Esseintes</span>
          <span
            className={`brand-mark ${sync.running ? 'walking' : ''}`}
            title={sync.running ? `Making the rounds: ${sync.currentStore ?? ''} (${sync.completed}/${sync.total})` : undefined}
          >
            <img src={tortoise} alt="" />
          </span>
        </button>

        <div className="header-right no-drag">
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault()
              if (search.trim()) shop(`“${search.trim()}”`, { search: search.trim() }, 'Search results')
            }}
          >
            <Search />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" />
          </form>
          <button
            className="icon-btn"
            title={sync.running ? `Updating ${sync.currentStore ?? ''} (${sync.completed}/${sync.total})` : `Updated ${timeAgo(sync.lastRunAt)} · click to refresh`}
            onClick={() => api.sync()}
          >
            <Refresh />
          </button>
          <button
            className="icon-btn badge-host"
            title={unreadAlerts ? `The Collection · ${unreadAlerts} new ${unreadAlerts === 1 ? 'update' : 'updates'}` : 'The Collection'}
            onClick={async () => {
              shop('The Collection', { favoritesOnly: true })
              if (unreadAlerts) {
                await api.markAlertsRead()
                bump()
              }
            }}
          >
            <Heart />
            {unreadAlerts > 0 && <span className="dot">{unreadAlerts > 9 ? '9+' : unreadAlerts}</span>}
          </button>
          <button className="icon-btn" title="Stores" onClick={() => go({ page: 'stores' })}>
            <Store />
          </button>
          <button className="icon-btn" title="Settings" onClick={() => go({ page: 'settings' })}>
            <Cog />
          </button>
        </div>
      </div>

      <nav className="header-nav" onMouseLeave={() => setMenu(null)}>
        <button onMouseEnter={() => setMenu(null)} onClick={() => shop("What's New", { sort: 'newest', individual: true })}>
          What’s New
        </button>
        {departments.map((d) => (
          <button
            key={d.name}
            className={menu === d.name ? 'hover' : ''}
            onMouseEnter={() => setMenu(d.categories.length > 1 ? d.name : null)}
            onClick={() => shop(d.name, { categories: d.categories })}
          >
            {d.name}
          </button>
        ))}
        <button className="nav-sale" onMouseEnter={() => setMenu(null)} onClick={() => shop('Sale', { onSale: true, sort: 'discount' })}>
          Sale
        </button>
        <button onMouseEnter={() => setMenu(null)} onClick={() => shop('Just Reduced', { justReduced: true }, 'Price drops from the last two weeks')}>
          Just Reduced
        </button>

        {open && (
          <div className="mega">
            <div className="mega-col">
              <div className="mega-heading">{open.name}</div>
              <button onClick={() => shop(open.name, { categories: open.categories })}>Shop all {open.name.toLowerCase()}</button>
            </div>
            <div className="mega-col mega-grid">
              {open.categories.map((c) => (
                <button key={c} onClick={() => shop(c, { categories: [c] })}>
                  {c} <span className="muted">{counts.get(c)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </nav>
    </header>
  )
}

export function PromoBar() {
  const { promotions } = useData()
  const { go } = useNav()
  const [i, setI] = useState(0)
  useEffect(() => {
    if (promotions.length < 2) return
    const t = setInterval(() => setI((n) => (n + 1) % promotions.length), 5000)
    return () => clearInterval(t)
  }, [promotions.length])

  if (!promotions.length) return null
  const p = promotions[i % promotions.length]
  return (
    <button
      className="promobar"
      onClick={() => go({ page: 'shop', title: p.storeName, query: { storeIds: [p.storeId] }, subtitle: p.text })}
    >
      <strong>{p.storeName}</strong>&nbsp;·&nbsp;{p.text}
      {p.code && !p.text.includes(p.code) ? ` · Code ${p.code}` : ''}
    </button>
  )
}
