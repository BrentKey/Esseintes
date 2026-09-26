import { useEffect, useState } from 'react'
import type { Store } from '@shared/types'
import { useData } from '../data'
import { api } from '../lib'
import { DepartmentPicker } from './Settings'
import { AddStore } from './Stores'

export function Onboarding() {
  const { settings, updateSettings } = useData()
  const [stores, setStores] = useState<Store[]>([])
  useEffect(() => {
    api.listStores().then(setStores)
  }, [])

  return (
    <div className="onboarding">
      <div className="onboarding-inner">
        <div className="wordmark big">Esseintes</div>
        <div className="tagline">À rebours</div>
        <p className="lede">A private stockist for the stores you love. New arrivals, price drops and sales, gathered each time you open it.</p>

        <div className="step">
          <div className="step-num">1</div>
          <div>
            <h3>What do you shop for?</h3>
            <DepartmentPicker value={settings.gender} onChange={(gender) => updateSettings({ gender })} />
          </div>
        </div>

        <div className="step">
          <div className="step-num">2</div>
          <div className="grow">
            <h3>Add your stores</h3>
            <p className="muted small">Paste one or more web addresses. You can add more later.</p>
            <AddStore compact onAdded={() => api.listStores().then(setStores)} />
            {stores.length > 0 && (
              <ul className="added">
                {stores.map((s) => (
                  <li key={s.id}>
                    {s.name} <span className="muted small">{s.url.replace(/^https?:\/\//, '')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <button className="btn btn-wide" disabled={!stores.length} onClick={() => updateSettings({ onboarded: true })}>
          Start shopping
        </button>
      </div>
    </div>
  )
}
