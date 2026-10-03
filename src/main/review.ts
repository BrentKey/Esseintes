import { DEPARTMENTS } from '@shared/categories'
import {
  groupKey,
  type Gender,
  type GroupLabel,
  type NewGroup,
  type ReviewChoice,
  type ReviewGroup,
  type Settings,
  type StoreReview,
  type StoreRules
} from '@shared/types'
import * as db from './db'

// A store's pieces are reviewed in groups: how they were labelled (men's,
// women's, unisex, unsure, or not for sale) within each category. The user's
// choice for each group is saved with the store and applied on every refresh.

export { groupKey }

const SAMPLES = 6

/** The choice a group starts with before the user changes it. */
export function defaultChoice(label: GroupLabel, settings: Settings): ReviewChoice {
  if (label === 'notForSale') return 'skip'
  if ((settings.gender === 'men' && label === 'women') || (settings.gender === 'women' && label === 'men')) return 'skip'
  return 'keep'
}

const labelOf = (key: string) => key.split('|')[0] as GroupLabel

/**
 * Applies a store's saved choices to freshly read pieces. Pieces in groups the
 * user hasn't seen yet follow the default for their label; those kept that way
 * are reported as new groups so the user can decide on them.
 */
export function applyRules(items: db.ReviewInput[], rules: StoreRules, settings: Settings): { kept: db.ReviewInput[]; newGroups: NewGroup[] } {
  const kept: db.ReviewInput[] = []
  const fresh = new Map<string, number>()
  for (const item of items) {
    const rule = rules.groups[item.groupKey]
    const choice = rule?.choice ?? defaultChoice(labelOf(item.groupKey), settings)
    if (choice === 'skip') continue
    if (!rule) fresh.set(item.groupKey, (fresh.get(item.groupKey) ?? 0) + 1)
    kept.push(relabel(item, choice, rule?.category ?? null))
  }
  return { kept, newGroups: [...fresh].map(([key, count]) => ({ key, count })) }
}

function relabel(item: db.ReviewInput, choice: ReviewChoice, category: string | null): db.ReviewInput {
  const gender: Gender = choice === 'men' || choice === 'women' || choice === 'unisex' ? choice : (item.gender as Gender)
  const cat = category ?? item.category
  if (gender === item.gender && cat === item.category) return item
  // The model key carries category and gender (store|category|gender|model).
  const [store, , , ...model] = item.modelKey.split('|')
  return { ...item, gender, category: cat, modelKey: [store, cat, gender, ...model].join('|') }
}

// Groups read in menu order: departments and their categories, then by label.
const CATEGORY_ORDER = DEPARTMENTS.flatMap((d) => d.categories)
const LABEL_ORDER: GroupLabel[] = ['men', 'unisex', 'unknown', 'women', 'notForSale']

function sortGroups(groups: ReviewGroup[]) {
  const cat = (c: string) => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : CATEGORY_ORDER.length)
  return groups.sort(
    (a, b) =>
      Number(a.label === 'notForSale') - Number(b.label === 'notForSale') ||
      cat(a.category) - cat(b.category) ||
      LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label)
  )
}

/** What there is to review at a store: everything held after its first read, or the groups that appeared since. */
export function getReview(storeId: number): StoreReview {
  const store = db.getStore(storeId)
  if (!store) throw new Error('That store no longer exists.')
  const settings = db.getSettings()
  const saved = store.rules?.groups ?? {}
  const group = (key: string, count: number, samples: db.ReviewInput[] | ReturnType<typeof db.reviewItems>): ReviewGroup => {
    const label = labelOf(key)
    return {
      key,
      label,
      category: key.slice(key.indexOf('|') + 1),
      count,
      choice: saved[key]?.choice ?? (store.review ? defaultChoice(label, settings) : 'keep'),
      moveTo: saved[key]?.category ?? null,
      samples: samples.slice(0, SAMPLES).map((p) => ({
        id: p.id,
        title: p.title,
        image: 'images' in p ? (p.images[0] ?? null) : p.image,
        price: p.price,
        currency: p.currency,
        url: p.url
      }))
    }
  }

  if (store.review) {
    const byKey = new Map<string, db.ReviewInput[]>()
    for (const item of db.heldForReview(storeId)) (byKey.get(item.groupKey) ?? byKey.set(item.groupKey, []).get(item.groupKey)!).push(item)
    const groups = [...byKey].map(([key, items]) => group(key, items.length, items))
    return { store, mode: 'initial', total: groups.reduce((n, g) => n + g.count, 0), groups: sortGroups(groups) }
  }
  const counts = db.feedGroupCounts(storeId)
  const groups = store.newGroups
    .filter((g) => counts.get(g.key))
    .map((g) => group(g.key, counts.get(g.key)!, db.reviewItems(storeId, g.key)))
  return { store, mode: 'new', total: groups.reduce((n, g) => n + g.count, 0), groups: sortGroups(groups) }
}

/**
 * Saves the user's choices. After a store's first read, the kept pieces go into
 * the feed and everything held for review is discarded. For groups that appeared
 * later, the choices are applied to the pieces already in the feed.
 */
export function saveReview(storeId: number, rules: StoreRules) {
  const store = db.getStore(storeId)
  if (!store) throw new Error('That store no longer exists.')
  const settings = db.getSettings()
  if (store.review) {
    const { kept } = applyRules(db.heldForReview(storeId), rules, settings)
    db.transaction(() => {
      kept.forEach((item, i) => db.upsertProduct({ ...item, position: i + 1 }, true, undefined))
      db.clearReview(storeId)
      db.updateStore(storeId, { rules, review: null, newGroups: [] })
    })
    return
  }
  const merged: StoreRules = { groups: { ...store.rules?.groups, ...rules.groups } }
  db.transaction(() => {
    db.deleteGroups(
      storeId,
      Object.entries(rules.groups)
        .filter(([, r]) => r.choice === 'skip')
        .map(([key]) => key)
    )
    for (const [key, r] of Object.entries(rules.groups)) {
      if (r.choice === 'skip') continue
      const gender = r.choice === 'keep' ? null : r.choice
      if (gender || r.category) db.relabelGroup(storeId, key, gender, r.category ?? null)
    }
    db.updateStore(storeId, { rules: merged, newGroups: store.newGroups.filter((g) => !rules.groups[g.key]) })
  })
}
