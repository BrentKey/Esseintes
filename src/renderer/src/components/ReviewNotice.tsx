import { useEffect, useState } from 'react'
import type { Store } from '@shared/types'
import { useLiveVersion, useSync } from '../data'
import { api } from '../lib'
import { useNav } from '../nav'

/**
 * Stores being read for the first time, stores ready for the user's review, and
 * reviewed stores where new kinds of pieces have turned up.
 */
export function ReviewNotice() {
  const { go } = useNav()
  const version = useLiveVersion()
  const sync = useSync()
  const [stores, setStores] = useState<Store[]>([])

  useEffect(() => {
    api.listStores().then(setStores)
  }, [version, sync.completed, sync.running])

  const reading = stores.filter((s) => s.review === 'reading' && s.enabled)
  const ready = stores.filter((s) => s.review === 'ready')
  const fresh = stores.filter((s) => !s.review && s.newGroups.length)
  if (!reading.length && !ready.length && !fresh.length) return null

  return (
    <div className="review-notices">
      {ready.map((s) => (
        <div key={s.id} className="notice notice-review">
          <span>
            <strong>{s.name}</strong> has been read and is ready for review. Nothing from it reaches your feed until you choose what to keep.
          </span>
          <button className="btn btn-small" onClick={() => go({ page: 'review', storeId: s.id })}>
            Review
          </button>
        </div>
      ))}
      {fresh.map((s) => (
        <div key={s.id} className="notice notice-review">
          <span>
            New at <strong>{s.name}</strong>: {s.newGroups.reduce((n, g) => n + g.count, 0)} pieces in{' '}
            {s.newGroups.length === 1 ? 'a group' : `${s.newGroups.length} groups`} you haven’t reviewed. They’re in your feed for now.
          </span>
          <button className="btn btn-small btn-outline" onClick={() => go({ page: 'review', storeId: s.id })}>
            Review
          </button>
        </div>
      ))}
      {reading.map((s) => (
        <div key={s.id} className="notice notice-review muted">
          <span>
            Reading <strong>{s.name}</strong>
            {s.lastError ? ` failed: ${s.lastError}` : '… You’ll be asked to review it once it’s read.'}
          </span>
        </div>
      ))}
    </div>
  )
}
