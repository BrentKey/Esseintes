import { useEffect, useState } from 'react'
import type { Store } from '@shared/types'
import { useData, useSync } from '../data'
import { api, timeAgo } from '../lib'
import { useNav } from '../nav'

const PLATFORM_LABEL: Record<string, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce', depict: 'Centra (Depict)', auralee: 'Auralee (gentle)', generic: 'Generic (sitemap)' }

export function Stores() {
  const { go } = useNav()
  const { version, bump, promotions } = useData()
  const sync = useSync()
  const [stores, setStores] = useState<Store[]>([])
  const [importMsg, setImportMsg] = useState<string | null>(null)

  useEffect(() => {
    api.listStores().then(setStores)
  }, [version, sync.completed, sync.running])

  const refresh = async () => {
    setStores(await api.listStores())
    bump()
  }

  return (
    <div className="page narrow">
      <h1 className="display">Stores</h1>
      <p className="muted">
        Add any online store. Shopify and WooCommerce stores are read in full through their public product feeds; other sites are read from
        their sitemap and product pages.
      </p>

      <AddStore onAdded={refresh} />

      <div className="store-tools">
        <button
          className="link"
          onClick={async () => {
            const r = await api.importStores()
            if (!r) return
            const parts = [
              `Added ${r.added.length} ${r.added.length === 1 ? 'store' : 'stores'}`,
              r.skipped.length && `${r.skipped.length} already added`,
              r.failed.length && `couldn’t add ${r.failed.join(', ')}`
            ].filter(Boolean)
            setImportMsg(parts.join(' · '))
            refresh()
          }}
        >
          Import a list of stores
        </button>
        {stores.length > 0 && (
          <button className="link" onClick={() => api.exportStores()}>
            Export my stores
          </button>
        )}
        {importMsg && <span className="muted small">{importMsg}</span>}
      </div>

      <div className="store-table">
        {stores.map((s) => (
          <div key={s.id} className={`store-row ${s.enabled ? '' : 'disabled'}`}>
            <div className="store-row-main">
              <div>
                <button className="store-title" onClick={() => go({ page: 'shop', title: s.name, query: { storeIds: [s.id] } })}>
                  {s.name}
                </button>
                <div className="muted small">
                  {s.url.replace(/^https?:\/\//, '')} · {s.platform ? PLATFORM_LABEL[s.platform] : 'Detecting…'} · {s.productCount} pieces
                  {s.gender !== 'mixed' ? ` · ${s.gender === 'men' ? 'menswear' : 'womenswear'} store` : ''} · updated{' '}
                  {timeAgo(s.lastSyncedAt)}
                </div>
                {s.lastError && <div className="error small">{s.lastError}</div>}
              </div>
              <div className="store-row-actions">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={async (e) => {
                      await api.updateStore(s.id, { enabled: e.target.checked })
                      refresh()
                    }}
                  />
                  Show
                </label>
                <button className="btn btn-small btn-outline" disabled={sync.running} onClick={() => api.sync(s.id)}>
                  Refresh
                </button>
                <button
                  className="btn btn-small btn-ghost"
                  onClick={async () => {
                    if (confirm(`Remove ${s.name} and all of its items?`)) {
                      await api.removeStore(s.id)
                      refresh()
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
            <StorePromotions store={s} promotions={promotions.filter((p) => p.storeId === s.id)} onChange={refresh} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function AddStore({ onAdded, compact }: { onAdded: () => void; compact?: boolean }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const urls = url.split(/[\s,]+/).filter(Boolean)
    if (!urls.length) return
    setBusy(true)
    setError(null)
    const errors: string[] = []
    for (const u of urls) {
      try {
        await api.addStore(u)
      } catch (err) {
        errors.push(`${u}: ${(err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
      }
    }
    setBusy(false)
    setError(errors.join('\n') || null)
    if (errors.length < urls.length) setUrl('')
    onAdded()
  }

  return (
    <form className={`add-store ${compact ? 'compact' : ''}`} onSubmit={submit}>
      <textarea
        value={url}
        rows={Math.min(6, Math.max(1, url.split('\n').length))}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          // Enter adds; Shift+Enter starts a new line for pasting several stores.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            e.currentTarget.form?.requestSubmit()
          }
        }}
        placeholder="Web addresses, e.g. example.com (one or many)"
        disabled={busy}
      />
      <button className="btn" disabled={busy || !url.trim()}>
        {busy ? 'Checking…' : 'Add store'}
      </button>
      {error && <div className="error small full">{error}</div>}
    </form>
  )
}

function StorePromotions({ store, promotions, onChange }: { store: Store; promotions: import('@shared/types').Promotion[]; onChange: () => void }) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [percent, setPercent] = useState('')
  const [code, setCode] = useState('')

  return (
    <div className="store-promos">
      {promotions.map((p) => (
        <div key={p.id} className="store-promo">
          <span>
            {p.percent ? <strong>{p.percent}% · </strong> : null}
            {p.text}
            {p.code ? ` · ${p.code}` : ''}
            <span className="muted small"> {p.manual ? '(added by you)' : '(detected)'}</span>
          </span>
          <button
            className="link small"
            onClick={async () => {
              await api.removePromotion(p.id)
              onChange()
            }}
          >
            Dismiss
          </button>
        </div>
      ))}
      {adding ? (
        <form
          className="promo-form"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!text.trim()) return
            await api.addPromotion(store.id, text.trim(), percent ? Number(percent) : null, code.trim() || null)
            setAdding(false)
            setText('')
            setPercent('')
            setCode('')
            onChange()
          }}
        >
          <input placeholder="e.g. 25% off everything" value={text} onChange={(e) => setText(e.target.value)} />
          <input placeholder="%" type="number" value={percent} onChange={(e) => setPercent(e.target.value)} className="w-sm" />
          <input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} className="w-md" />
          <button className="btn btn-small">Save</button>
          <button type="button" className="link small" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="link small" onClick={() => setAdding(true)}>
          + Add a sale or code manually
        </button>
      )}
    </div>
  )
}
