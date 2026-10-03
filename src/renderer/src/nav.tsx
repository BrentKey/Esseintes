import { createContext, useContext } from 'react'
import type { ProductQuery } from '@shared/types'

export type Route =
  | { page: 'home' }
  | { page: 'shop'; title: string; query: ProductQuery; subtitle?: string }
  | { page: 'product'; id: string }
  | { page: 'stores' }
  | { page: 'review'; storeId: number }
  | { page: 'settings' }

export interface Nav {
  route: Route
  go(route: Route): void
  back(): void
  canGoBack: boolean
}

export const NavContext = createContext<Nav>(null!)
export const useNav = () => useContext(NavContext)
