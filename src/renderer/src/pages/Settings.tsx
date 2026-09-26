import { useEffect, useState } from 'react'
import type { Facet, GenderPreference, Settings as S } from '@shared/types'
import { useData } from '../data'
import { api } from '../lib'

export function Settings() {
  const { settings, updateSettings, version } = useData()
  const [facets, setFacets] = useState<{ brands: Facet[]; categories: Facet[] }>({ brands: [], categories: [] })
  const [currencies, setCurrencies] = useState<string[]>([])
  useEffect(() => {
    api.queryProducts({ limit: 0 }).then((r) => setFacets(r.facets))
  }, [version])
  useEffect(() => {
    // Common currencies first, then everything else the rates source knows.
    api.listCurrencies().then((all) => {
      const set = new Set([settings.currency, ...Object.keys(CURRENCY_NAMES), ...all])
      setCurrencies([...set])
    })
  }, [settings.currency])

  return (
    <div className="page narrow">
      <h1 className="display">Settings</h1>

      <section className="setting">
        <h3>Department</h3>
        <p className="muted small">
          Esseintes only collects items for your department, using each store’s own men’s and women’s sections. Changing this re-reads your
          stores.
        </p>
        <DepartmentPicker value={settings.gender} onChange={(gender) => updateSettings({ gender })} />
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.includeUnknownGender}
            onChange={(e) => updateSettings({ includeUnknownGender: e.target.checked })}
          />
          Include items a store doesn’t label as men’s or women’s (e.g. unisex eyewear)
        </label>
      </section>

      <section className="setting">
        <h3>My sizes</h3>
        <p className="muted small">Sizes you wear across clothing and shoes, e.g. M, L, 32, 10.5. They’re highlighted on product pages.</p>
        <SizeInput sizes={settings.mySizes} onChange={(mySizes) => updateSettings({ mySizes })} />
        <label className="toggle">
          <input type="checkbox" checked={settings.onlyMySizes} onChange={(e) => updateSettings({ onlyMySizes: e.target.checked })} />
          Only show items in stock in my sizes (one-size items are always shown)
        </label>
      </section>

      <section className="setting">
        <h3>Hidden</h3>
        <p className="muted small">Designers and categories you never want to see. Pieces in your collection always stay visible there.</p>
        <HiddenList
          label="designer"
          hidden={settings.hiddenBrands}
          options={facets.brands.map((b) => b.value)}
          onChange={(hiddenBrands) => updateSettings({ hiddenBrands })}
        />
        <HiddenList
          label="category"
          hidden={settings.hiddenCategories}
          options={facets.categories.map((c) => c.value)}
          onChange={(hiddenCategories) => updateSettings({ hiddenCategories })}
        />
      </section>

      <section className="setting">
        <h3>Collection alerts</h3>
        <p className="muted small">
          Desktop notifications when a piece in your collection changes. Alerts also appear on the home page.
          {settings.mySizes.length ? ' Restocks only count sizes you’ve saved above.' : ' Add your sizes above to only hear about restocks you can buy.'}
        </p>
        <label className="toggle">
          <input type="checkbox" checked={settings.notifyPriceDrops} onChange={(e) => updateSettings({ notifyPriceDrops: e.target.checked })} />
          Price drops
        </label>
        <label className="toggle">
          <input type="checkbox" checked={settings.notifyBackInStock} onChange={(e) => updateSettings({ notifyBackInStock: e.target.checked })} />
          Back in stock
        </label>
      </section>

      <section className="setting">
        <h3>Currency</h3>
        <p className="muted small">Prices are converted at daily exchange rates. The store’s own price is shown on each product page.</p>
        <select value={settings.currency} onChange={(e) => updateSettings({ currency: e.target.value })}>
          {currencies.map((c) => (
            <option key={c} value={c}>
              {c}
              {CURRENCY_NAMES[c] ? ` · ${CURRENCY_NAMES[c]}` : ''}
            </option>
          ))}
        </select>
      </section>

      <section className="setting">
        <h3>Updates</h3>
        <p className="muted small">Stores are always checked when the app opens. While it stays open, check again every:</p>
        <select value={settings.refreshHours} onChange={(e) => updateSettings({ refreshHours: Number(e.target.value) } as Partial<S>)}>
          <option value={0}>Only on launch</option>
          <option value={1}>Hour</option>
          <option value={3}>3 hours</option>
          <option value={6}>6 hours</option>
          <option value={12}>12 hours</option>
          <option value={24}>Day</option>
        </select>
      </section>
    </div>
  )
}

const CURRENCY_NAMES: Record<string, string> = {
  USD: 'US dollar', EUR: 'Euro', GBP: 'British pound', CAD: 'Canadian dollar', AUD: 'Australian dollar', JPY: 'Japanese yen',
  CHF: 'Swiss franc', SEK: 'Swedish krona', DKK: 'Danish krone', NOK: 'Norwegian krone', NZD: 'New Zealand dollar',
  HKD: 'Hong Kong dollar', SGD: 'Singapore dollar', KRW: 'South Korean won', CNY: 'Chinese yuan'
}

export function DepartmentPicker({ value, onChange }: { value: GenderPreference; onChange: (v: GenderPreference) => void }) {
  return (
    <div className="segmented">
      {(['men', 'women', 'all'] as const).map((g) => (
        <button key={g} className={value === g ? 'on' : ''} onClick={() => onChange(g)}>
          {g === 'men' ? 'Menswear' : g === 'women' ? 'Womenswear' : 'Both'}
        </button>
      ))}
    </div>
  )
}

function HiddenList({
  label,
  hidden,
  options,
  onChange
}: {
  label: string
  hidden: string[]
  options: string[]
  onChange: (v: string[]) => void
}) {
  const available = options.filter((o) => !hidden.includes(o)).sort((a, b) => a.localeCompare(b))
  return (
    <div className="size-input">
      {hidden.map((h) => (
        <button key={h} className="chip on" onClick={() => onChange(hidden.filter((x) => x !== h))} title="Show again">
          {h} ×
        </button>
      ))}
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) onChange([...hidden, e.target.value])
        }}
      >
        <option value="">Hide a {label}…</option>
        {available.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  )
}

function SizeInput({ sizes, onChange }: { sizes: string[]; onChange: (s: string[]) => void }) {
  const [text, setText] = useState('')
  const add = () => {
    const next = text
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s && !sizes.includes(s))
    if (next.length) onChange([...sizes, ...next])
    setText('')
  }
  return (
    <div className="size-input">
      {sizes.map((s) => (
        <button key={s} className="chip on" onClick={() => onChange(sizes.filter((x) => x !== s))} title="Remove">
          {s} ×
        </button>
      ))}
      <input
        value={text}
        placeholder="Add a size"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
      />
    </div>
  )
}
