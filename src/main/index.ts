import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { load } from 'cheerio'
import type { ImportResult, ProductQuery, Settings } from '@shared/types'
import type { NewAlert } from './alerts'
import * as db from './db'
import { baseUrl, fetchText } from './http'
import { cleanStoreName } from './brands'
import { refreshRates } from './currency'
import { parseStoreList } from './storelist'
import * as sync from './sync'

let win: BrowserWindow | null = null
let previousVisit: string | null = null
let refreshTimer: NodeJS.Timeout | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'Esseintes',
    backgroundColor: '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  // Links to stores open in the user's normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file:')) e.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

async function guessStoreName(base: string): Promise<string> {
  const host = new URL(base).hostname.replace(/^www\./, '')
  try {
    const $ = load(await fetchText(base))
    const name = cleanStoreName($('meta[property="og:site_name"]').attr('content') || $('title').first().text().split(/[|–—]/)[0])
    if (name && name.length <= 40) return name
  } catch {
    /* fall back to domain */
  }
  const stem = host.split('.')[0]
  return stem.charAt(0).toUpperCase() + stem.slice(1)
}

async function addStore(url: string, name?: string) {
  const base = baseUrl(url)
  if (db.listStores().some((s) => s.url === base)) throw new Error('That store has already been added.')
  const store = db.insertStore(base, name?.trim() || (await guessStoreName(base)), 'mixed')
  const adapter = await sync.detectPlatform(base)
  db.updateStore(store.id, { platform: adapter.platform })
  void sync.runSync(store.id)
  return db.getStore(store.id)!
}

async function importStores(): Promise<ImportResult | null> {
  const pick = await dialog.showOpenDialog(win!, {
    title: 'Import stores',
    properties: ['openFile'],
    filters: [{ name: 'Store lists', extensions: ['json', 'txt', 'csv'] }]
  })
  if (pick.canceled || !pick.filePaths[0]) return null
  const entries = parseStoreList(await readFile(pick.filePaths[0], 'utf8'))
  const result: ImportResult = { added: [], skipped: [], failed: [] }
  const known = new Set(db.listStores().map((s) => s.url))
  for (const e of entries) {
    let base: string
    try {
      base = baseUrl(e.url)
    } catch {
      result.failed.push(e.url)
      continue
    }
    if (known.has(base)) {
      result.skipped.push(base)
      continue
    }
    known.add(base)
    try {
      const store = await addStore(base, e.name)
      result.added.push(store.name)
    } catch {
      result.failed.push(base)
    }
  }
  return result
}

async function exportStores(): Promise<boolean> {
  const save = await dialog.showSaveDialog(win!, { title: 'Export stores', defaultPath: 'esseintes-stores.json' })
  if (save.canceled || !save.filePath) return false
  const stores = db.listStores().map((s) => ({ name: s.name, url: s.url }))
  await writeFile(save.filePath, JSON.stringify({ app: 'esseintes', version: 1, stores }, null, 2))
  return true
}

function openProduct(id?: string) {
  if (!win) createWindow()
  win!.show()
  win!.focus()
  if (id) win!.webContents.send('open-product', id)
}

function notify(alerts: NewAlert[]) {
  const settings = db.getSettings()
  const wanted = alerts.filter((a) => (a.kind === 'price-drop' ? settings.notifyPriceDrops : settings.notifyBackInStock))
  if (!wanted.length || !Notification.isSupported()) return
  // A handful get their own notification; more than that are summarised.
  if (wanted.length <= 3) {
    for (const a of wanted) {
      const p = db.getProduct(a.productId)
      if (!p) continue
      const n = new Notification({
        title: a.kind === 'price-drop' ? `Price drop: ${p.brand}` : `Back in stock: ${p.brand}`,
        body: `${p.title}\n${a.message}`,
        silent: false
      })
      n.on('click', () => openProduct(p.id))
      n.show()
    }
  } else {
    const drops = wanted.filter((a) => a.kind === 'price-drop').length
    const back = wanted.length - drops
    const parts = [drops && `${drops} price ${drops === 1 ? 'drop' : 'drops'}`, back && `${back} back in stock`].filter(Boolean)
    const n = new Notification({ title: 'News from the Collection', body: `${parts.join(' and ')} on pieces you’ve saved.` })
    n.on('click', () => openProduct())
    n.show()
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer)
  const hours = db.getSettings().refreshHours
  if (hours > 0) refreshTimer = setInterval(() => sync.runSync(), hours * 3_600_000)
}

function registerIpc() {
  ipcMain.handle('settings:get', () => db.getSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => {
    const before = db.getSettings()
    const s = db.saveSettings(patch)
    if ('refreshHours' in patch) scheduleRefresh()
    // A new department changes which items are fetched, so re-read every store.
    if (patch.gender && patch.gender !== before.gender) void sync.runSync()
    return s
  })

  ipcMain.handle('stores:list', () => db.listStores())
  ipcMain.handle('stores:add', (_e, url: string, name?: string) => addStore(url, name))
  ipcMain.handle('stores:import', () => importStores())
  ipcMain.handle('stores:export', () => exportStores())
  ipcMain.handle('stores:update', (_e, id: number, patch: { name?: string; enabled?: boolean }) =>
    db.updateStore(id, { name: patch.name, enabled: patch.enabled })
  )
  ipcMain.handle('stores:remove', (_e, id: number) => db.deleteStore(id))

  ipcMain.handle('promotions:add', (_e, storeId: number, text: string, percent: number | null, code: string | null) =>
    db.addManualPromotion(storeId, text, percent, code)
  )
  ipcMain.handle('promotions:remove', (_e, id: number) => db.deletePromotion(id))
  ipcMain.handle('promotions:list', () => db.listPromotions())

  ipcMain.handle('products:query', (_e, q: ProductQuery) => db.queryProducts(q))
  ipcMain.handle('products:get', (_e, id: string) => db.getProduct(id))
  ipcMain.handle('products:favorite', (_e, id: string) => db.toggleFavorite(id))
  ipcMain.handle('products:save-favorite', (_e, id: string, size: string | null) => db.saveFavorite(id, size))
  ipcMain.handle('home:get', () => db.getHome(previousVisit))
  ipcMain.handle('alerts:list', () => db.listAlerts())
  ipcMain.handle('currencies:list', () => db.availableCurrencies())
  ipcMain.handle('alerts:read', () => db.markAlertsRead())

  ipcMain.handle('sync:run', (_e, storeId?: number) => {
    void sync.runSync(storeId)
  })
  ipcMain.handle('sync:status', () => sync.getStatus())
  ipcMain.handle('shell:open', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
  })
}

/**
 * Headless check used when developing adapters:
 *   npm run smoke -- store1.com store2.com
 * Syncs into a throwaway database and prints what was found.
 */
async function smokeTest(urls: string[]) {
  db.openDb(join(app.getPath('temp'), `esseintes-smoke-${Date.now()}.db`))
  for (const u of urls) {
    const base = baseUrl(u)
    const store = db.insertStore(base, await guessStoreName(base), 'mixed')
    console.log(`+ ${store.name} (${base}) → ${(await sync.detectPlatform(base)).platform}`)
  }
  const started = Date.now()
  await sync.runSync()
  console.log(`\nSynced in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  for (const r of sync.getStatus().results) console.log(r)
  const page = db.queryProducts({ limit: 5 })
  console.log(`\n${page.total} products. Categories:`, page.facets.categories.map((c) => `${c.label} ${c.count}`).join(', '))
  console.log('Top sizes:', page.facets.sizes.slice(0, 15).map((s) => s.label).join(' '))
  for (const g of ['men', 'women'] as const) {
    db.saveSettings({ gender: g, includeUnknownGender: false })
    console.log(`${g}: ${db.queryProducts({ limit: 0 }).total}`)
  }
  db.saveSettings({ gender: 'all' })
  console.log('On sale:', db.queryProducts({ onSale: true, limit: 0 }).total)
  for (const p of page.items) console.log(' -', p.brand, '|', p.title, '|', p.category, '|', p.gender, '|', p.price, p.currency, '|', p.sizes.map((s) => s.label + (s.available ? '' : '✗')).join(' '), '|', p.images.length, 'imgs')
  console.log('\nPromotions:', db.listPromotions().map((p) => `[${p.storeName}] ${p.text} (${p.percent ?? '-'}%, code ${p.code ?? '-'}, sitewide ${p.sitewide})`))
}

/** Copies data over from when the app was called Stockroom (the old folder is left untouched). */
function migrateFromStockroom(dbFile: string) {
  const old = join(app.getPath('appData'), 'stockroom', 'stockroom.db')
  if (existsSync(dbFile) || !existsSync(old)) return
  mkdirSync(dirname(dbFile), { recursive: true })
  for (const ext of ['', '-wal', '-shm']) if (existsSync(old + ext)) copyFileSync(old + ext, dbFile + ext)
}

app.whenReady().then(async () => {
  const smoke = process.argv.indexOf('--smoke')
  if (smoke >= 0) {
    await smokeTest(process.argv.slice(smoke + 1))
    app.quit()
    return
  }

  const dbFile = join(app.getPath('userData'), 'esseintes.db')
  migrateFromStockroom(dbFile)
  db.openDb(dbFile)
  // Tidy names saved before "Official Store"-style suffixes were stripped.
  for (const s of db.listStores()) if (cleanStoreName(s.name) !== s.name) db.updateStore(s.id, { name: cleanStoreName(s.name) })
  // Remember the previous session so the home page can show what's new since then.
  previousVisit = db.getSettings().lastVisitAt
  db.saveSettings({ lastVisitAt: new Date().toISOString() })

  // Packaged builds get the icon from the bundle; show it in the Dock during development too.
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(__dirname, '../../build/icon.png'))

  registerIpc()
  sync.onStatus((s) => win?.webContents.send('sync:status', s))
  sync.onAlerts(notify)
  createWindow()
  void refreshRates()

  // ESSEINTES_NO_AUTOSYNC=1 opens without re-reading every store (for quick testing).
  if (!process.env.ESSEINTES_NO_AUTOSYNC) {
    void sync.runStaleSync()
    scheduleRefresh()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
