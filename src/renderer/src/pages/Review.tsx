import { useEffect, useMemo, useState } from 'react'
import { DEPARTMENTS, departmentOf } from '@shared/categories'
import type { GroupLabel, GroupRule, ReviewChoice, ReviewGroup, ReviewItem, StoreReview } from '@shared/types'
import { useData } from '../data'
import { api, money, sized } from '../lib'
import { useNav } from '../nav'

const LABEL: Record<GroupLabel, string> = {
  men: 'Men’s',
  women: 'Women’s',
  unisex: 'Unisex',
  unknown: 'Unsure',
  notForSale: 'Not for sale'
}

const ALL_CATEGORIES = DEPARTMENTS.flatMap((d) => d.categories)

/** The choices offered for a group: keep as labelled, skip, or keep under another label. */
function choicesFor(label: GroupLabel): { value: ReviewChoice; text: string }[] {
  const keep = label === 'unknown' || label === 'notForSale' ? 'Keep' : `Keep as ${LABEL[label].toLowerCase()}`
  return [
    { value: 'keep', text: keep },
    { value: 'skip', text: 'Skip' },
    ...(['men', 'unisex', 'women'] as const).filter((g) => g !== label).map((g) => ({ value: g, text: `Keep as ${LABEL[g].toLowerCase()}` }))
  ]
}

/**
 * Reviewing a store: its pieces in groups (category × how they were labelled),
 * each kept, skipped or relabelled. The choices are saved with the store and
 * applied on every refresh.
 */
export function Review({ storeId }: { storeId: number }) {
  const { go } = useNav()
  const { bump } = useData()
  const [review, setReview] = useState<StoreReview | null>(null)
  const [rules, setRules] = useState<Record<string, GroupRule>>({})
  const [open, setOpen] = useState<Record<string, ReviewItem[] | 'loading'>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .getReview(storeId)
      .then((r) => {
        setReview(r)
        setRules(Object.fromEntries(r.groups.map((g) => [g.key, { choice: g.choice, ...(g.moveTo ? { category: g.moveTo } : {}) }])))
      })
      .catch((e) => setError(String(e.message ?? e)))
  }, [storeId])

  const sections = useMemo(() => {
    const out: { name: string; groups: ReviewGroup[] }[] = []
    for (const g of review?.groups ?? []) {
      const name = g.label === 'notForSale' ? 'Not for sale' : departmentOf(g.category)
      const last = out[out.length - 1]
      if (last?.name === name) last.groups.push(g)
      else out.push({ name, groups: [g] })
    }
    return out
  }, [review])

  if (error) return <div className="page narrow"><p className="error">{error}</p></div>
  if (!review) return null
  const { store } = review

  if (!review.groups.length)
    return (
      <div className="page narrow">
        <h1 className="display">{store.name}</h1>
        <p className="muted">{store.review === 'reading' ? 'Still reading this store. It will be ready to review shortly.' : 'Nothing to review here.'}</p>
      </div>
    )

  const keeping = review.groups.filter((g) => rules[g.key]?.choice !== 'skip').reduce((n, g) => n + g.count, 0)
  const set = (key: string, patch: Partial<GroupRule>) => setRules((r) => ({ ...r, [key]: { ...r[key], ...patch } }))
  const setLabel = (label: GroupLabel, choice: ReviewChoice) =>
    setRules((r) => ({ ...r, ...Object.fromEntries(review.groups.filter((g) => g.label === label).map((g) => [g.key, { ...r[g.key], choice }])) }))
  const labels = [...new Set(review.groups.map((g) => g.label))]

  async function toggle(g: ReviewGroup) {
    if (open[g.key]) {
      setOpen(({ [g.key]: _, ...rest }) => rest)
      return
    }
    setOpen((o) => ({ ...o, [g.key]: 'loading' }))
    const items = await api.getReviewItems(storeId, g.key)
    setOpen((o) => ({ ...o, [g.key]: items }))
  }

  async function save() {
    setSaving(true)
    try {
      await api.saveReview(storeId, { groups: rules })
      bump()
      go({ page: 'shop', title: store.name, query: { storeIds: [store.id] } })
    } catch (e) {
      setError(String((e as Error).message))
      setSaving(false)
    }
  }

  return (
    <div className="page review">
      <div className="eyebrow">{review.mode === 'initial' ? 'Review a new store' : 'New at this store'}</div>
      <h1 className="display">{store.name}</h1>
      <p className="muted">
        {review.mode === 'initial'
          ? `${review.total.toLocaleString()} pieces read, sorted by category and by how they’re labelled. Choose what to keep; only those reach your feed, and every refresh follows your choices. Skipped pieces aren’t stored. To choose again later, use Start over on the Stores page.`
          : 'These groups turned up since you reviewed the store. They’re in your feed for now; choose what to keep.'}
      </p>
      {labels.length > 1 && (
        <div className="review-quick muted small">
          Set all:{' '}
          {labels.map((l) => (
            <span key={l} className="review-quick-item">
              {LABEL[l]}{' '}
              <button className="link small" onClick={() => setLabel(l, 'keep')}>keep</button>
              {' / '}
              <button className="link small" onClick={() => setLabel(l, 'skip')}>skip</button>
            </span>
          ))}
        </div>
      )}

      {sections.map((sec) => (
        <section key={sec.name} className="review-section">
          <h2 className="review-section-title">{sec.name}</h2>
          {sec.groups.map((g) => {
            const rule = rules[g.key] ?? { choice: g.choice }
            const items = open[g.key]
            return (
              <div key={g.key} className={`review-group ${rule.choice === 'skip' ? 'skipped' : ''}`}>
                <div className="review-group-head">
                  <button className="review-group-name" onClick={() => toggle(g)} title="See every piece in this group">
                    <span className="review-cat">{g.label === 'notForSale' ? 'Lookbooks & placeholders' : g.category}</span>
                    <span className={`review-label label-${g.label}`}>{LABEL[g.label]}</span>
                    <span className="muted">
                      {g.count} {items ? '▴' : '▾'}
                    </span>
                  </button>
                  <div className="review-thumbs" onClick={() => toggle(g)}>
                    {g.samples.map((p) => (p.image ? <img key={p.id} src={sized(p.image, 120)} alt="" loading="lazy" /> : null))}
                  </div>
                  <div className="review-controls">
                    <select value={rule.choice} onChange={(e) => set(g.key, { choice: e.target.value as ReviewChoice })}>
                      {choicesFor(g.label).map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.text}
                        </option>
                      ))}
                    </select>
                    {rule.choice !== 'skip' && (
                      <select
                        value={rule.category ?? ''}
                        onChange={(e) => set(g.key, { category: e.target.value || undefined })}
                        title="File this group under another category"
                      >
                        <option value="">{g.label === 'notForSale' ? 'Category: Other' : `Category: ${g.category}`}</option>
                        {ALL_CATEGORIES.filter((c) => c !== g.category).map((c) => (
                          <option key={c} value={c}>
                            Move to {c}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
                {items && (
                  <div className="review-items">
                    {items === 'loading' ? (
                      <span className="muted small">Loading…</span>
                    ) : (
                      items.map((p) => (
                        <button key={p.id} className="review-item" onClick={() => api.openExternal(p.url)} title="Open on the store’s site">
                          {p.image ? <img src={sized(p.image, 240)} alt="" loading="lazy" /> : <div className="review-noimg" />}
                          <span className="review-item-title">{p.title}</span>
                          <span className="muted small">{money(p.price, p.currency)}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </section>
      ))}

      <div className="review-save">
        <span className="muted">
          Keeping {keeping.toLocaleString()} of {review.total.toLocaleString()} pieces
        </span>
        <button className="btn" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : review.mode === 'initial' ? 'Add to my feed' : 'Save'}
        </button>
      </div>
    </div>
  )
}
