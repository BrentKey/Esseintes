import { contextBridge, ipcRenderer } from 'electron'
import type { Api, SyncStatus } from '@shared/types'

const api: Api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  listStores: () => ipcRenderer.invoke('stores:list'),
  addStore: (url, name) => ipcRenderer.invoke('stores:add', url, name),
  updateStore: (id, patch) => ipcRenderer.invoke('stores:update', id, patch),
  removeStore: (id) => ipcRenderer.invoke('stores:remove', id),
  addPromotion: (storeId, text, percent, code) => ipcRenderer.invoke('promotions:add', storeId, text, percent, code),
  removePromotion: (id) => ipcRenderer.invoke('promotions:remove', id),
  listPromotions: () => ipcRenderer.invoke('promotions:list'),
  queryProducts: (q) => ipcRenderer.invoke('products:query', q),
  getProduct: (id) => ipcRenderer.invoke('products:get', id),
  getHome: () => ipcRenderer.invoke('home:get'),
  getReview: (storeId) => ipcRenderer.invoke('review:get', storeId),
  getReviewItems: (storeId, key) => ipcRenderer.invoke('review:items', storeId, key),
  saveReview: (storeId, rules) => ipcRenderer.invoke('review:save', storeId, rules),
  startOver: (storeId) => ipcRenderer.invoke('stores:start-over', storeId),
  toggleFavorite: (id) => ipcRenderer.invoke('products:favorite', id),
  saveFavorite: (id, size) => ipcRenderer.invoke('products:save-favorite', id, size),
  sync: (storeId) => ipcRenderer.invoke('sync:run', storeId),
  getSyncStatus: () => ipcRenderer.invoke('sync:status'),
  onSyncStatus: (cb) => {
    const handler = (_e: unknown, s: SyncStatus) => cb(s)
    ipcRenderer.on('sync:status', handler)
    return () => ipcRenderer.removeListener('sync:status', handler)
  },
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  importStores: () => ipcRenderer.invoke('stores:import'),
  exportStores: () => ipcRenderer.invoke('stores:export'),
  listAlerts: () => ipcRenderer.invoke('alerts:list'),
  listCurrencies: () => ipcRenderer.invoke('currencies:list'),
  markAlertsRead: () => ipcRenderer.invoke('alerts:read'),
  onOpenProduct: (cb) => {
    const handler = (_e: unknown, id: string) => cb(id)
    ipcRenderer.on('open-product', handler)
    return () => ipcRenderer.removeListener('open-product', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
