import { createContext, useContext } from 'react'
import type { Promotion, Settings, SyncStatus } from '@shared/types'

export interface AppData {
  settings: Settings
  updateSettings(patch: Partial<Settings>): Promise<void>
  promotions: Promotion[]
  sync: SyncStatus
  /** Collection alerts the user hasn't seen yet. */
  unreadAlerts: number
  /** Increments whenever stored data changes, so views know to reload. */
  version: number
  bump(): void
}

export const DataContext = createContext<AppData>(null!)
export const useData = () => useContext(DataContext)
