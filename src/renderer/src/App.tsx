import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Promotion, Settings, SyncStatus } from '@shared/types'
import { Header, PromoBar } from './components/Header'
import { ActiveContext, DataContext, SyncContext } from './data'
import { api } from './lib'
import { NavContext, type Route } from './nav'
import { Home } from './pages/Home'
import { Onboarding } from './pages/Onboarding'
import { Product } from './pages/Product'
import { Settings as SettingsPage } from './pages/Settings'
import { Shop } from './pages/Shop'
import { Stores } from './pages/Stores'

interface Entry {
  key: number
  route: Route
  /** Scroll position when the user navigated away, restored on Back. */
  scroll: number
}

// Recent pages stay mounted (just hidden), so Back returns to exactly where you
// were: loaded items, filters and scroll position intact.
const KEEP_ALIVE = 6
const REFRESH_MS = 10_000

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [sync, setSync] = useState<SyncStatus>({ running: false, currentStore: null, completed: 0, total: 0, lastRunAt: null, results: [] })
  const [version, setVersion] = useState(0)
  const [unreadAlerts, setUnreadAlerts] = useState(0)
  const [stack, setStack] = useState<Entry[]>([{ key: 0, route: { page: 'home' }, scroll: 0 }])
  const nextKey = useRef(1)
  const main = useRef<HTMLElement>(null)
  const pendingScroll = useRef<number | null>(null)

  const bump = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    api.getSettings().then(setSettings)
    api.getSyncStatus().then(setSync)
    // Refresh views as stores finish so items appear progressively, but at most
    // every REFRESH_MS while a sync runs (each refresh re-queries every open view),
    // and always once when it ends.
    let completed = -1
    let last = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      clearTimeout(timer)
      timer = undefined
      last = Date.now()
      setVersion((v) => v + 1)
    }
    const off = api.onSyncStatus((s) => {
      setSync(s)
      if (!s.running) refresh()
      else if (s.completed !== completed && !timer) timer = setTimeout(refresh, Math.max(0, last + REFRESH_MS - Date.now()))
      completed = s.completed
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [])

  useEffect(() => {
    api.listPromotions().then(setPromotions)
    api.listAlerts().then((a) => setUnreadAlerts(a.filter((x) => !x.read).length))
  }, [version])

  // Clicking a desktop notification opens that product.
  useEffect(
    () =>
      api.onOpenProduct((id) => {
        const y = main.current?.scrollTop ?? 0
        setStack((s) => [...s.slice(-30, -1), { ...s[s.length - 1], scroll: y }, { key: nextKey.current++, route: { page: 'product', id }, scroll: 0 }])
        pendingScroll.current = 0
      }),
    []
  )

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await api.saveSettings(patch))
    setVersion((v) => v + 1)
  }, [])

  const top = stack[stack.length - 1]
  const route = top.route
  const nav = useMemo(
    () => ({
      route,
      canGoBack: stack.length > 1,
      go(r: Route) {
        const y = main.current?.scrollTop ?? 0
        setStack((s) => [...s.slice(-30, -1), { ...s[s.length - 1], scroll: y }, { key: nextKey.current++, route: r, scroll: 0 }])
        pendingScroll.current = 0
      },
      back() {
        if (stack.length < 2) return
        pendingScroll.current = stack[stack.length - 2].scroll
        setStack((s) => s.slice(0, -1))
      }
    }),
    [route, stack]
  )

  // ⌘[ / Alt+← and a mouse's back button go back, like a browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (((e.metaKey || e.ctrlKey) && e.key === '[') || (e.altKey && e.key === 'ArrowLeft' && !typing)) nav.back()
    }
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) nav.back()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [nav])

  // Apply the scroll position as soon as the page switch is painted. A page that
  // was too far back to stay mounted re-renders, so try again once data loads.
  useLayoutEffect(() => {
    const y = pendingScroll.current
    if (y == null) return
    pendingScroll.current = null
    main.current?.scrollTo(0, y)
    if (y === 0) return
    const t = setTimeout(() => main.current && Math.abs(main.current.scrollTop - y) > 2 && main.current.scrollTo(0, y), 300)
    return () => clearTimeout(t)
  }, [top.key])

  const data = useMemo(
    () => (settings ? { settings, updateSettings, promotions, unreadAlerts, version, bump } : null),
    [settings, updateSettings, promotions, unreadAlerts, version, bump]
  )

  if (!settings || !data) return null

  return (
    <DataContext.Provider value={data}>
      <SyncContext.Provider value={sync}>
      <NavContext.Provider value={nav}>
        {!settings.onboarded ? (
          <Onboarding />
        ) : (
          <div className="app">
            <PromoBar />
            <Header />
            <main ref={main} className="main">
              {stack.slice(-KEEP_ALIVE).map((e) => (
                <div key={e.key} hidden={e.key !== top.key}>
                  <ActiveContext.Provider value={e.key === top.key}>
                    <View route={e.route} />
                  </ActiveContext.Provider>
                </div>
              ))}
              <footer className="footer muted small">
                Prices and stock are confirmed on each store’s own site.
              </footer>
            </main>
          </div>
        )}
      </NavContext.Provider>
      </SyncContext.Provider>
    </DataContext.Provider>
  )
}

function View({ route }: { route: Route }) {
  switch (route.page) {
    case 'home':
      return <Home />
    case 'shop':
      return <Shop title={route.title} subtitle={route.subtitle} query={route.query} />
    case 'product':
      return <Product id={route.id} />
    case 'stores':
      return <Stores />
    case 'settings':
      return <SettingsPage />
  }
}
