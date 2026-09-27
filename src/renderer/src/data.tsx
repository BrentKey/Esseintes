import { createContext, useContext, useRef } from 'react'
import type { Promotion, Settings, SyncStatus } from '@shared/types'

export interface AppData {
  settings: Settings
  updateSettings(patch: Partial<Settings>): Promise<void>
  promotions: Promotion[]
  /** Collection alerts the user hasn't seen yet. */
  unreadAlerts: number
  /** Increments whenever stored data changes, so views know to reload. */
  version: number
  bump(): void
}

export const DataContext = createContext<AppData>(null!)
export const useData = () => useContext(DataContext)

// Sync progress changes often; kept separate so only views that show it re-render.
export const SyncContext = createContext<SyncStatus>(null!)
export const useSync = () => useContext(SyncContext)

// Whether the page is the one on screen (earlier pages stay mounted, hidden, for Back).
export const ActiveContext = createContext(true)

/**
 * The data version for a page to reload on. A hidden page keeps the version it
 * last showed, so it reloads once when you return to it rather than on every change.
 */
export function useLiveVersion(): number {
  const { version } = useData()
  const active = useContext(ActiveContext)
  const shown = useRef(version)
  if (active) shown.current = version
  return shown.current
}
