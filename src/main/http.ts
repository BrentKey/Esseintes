import { net } from 'electron'

// Uses Chromium's network stack (via Electron) rather than Node's, so
// requests look like an ordinary browser to store CDNs.
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9'
}

export class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} for ${url}`)
  }
}

export async function fetchText(url: string, accept = 'text/html,*/*', retries = 2): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await net.fetch(url, {
        // No cookies: stores remember a visitor's language/country in one, which
        // would silently change later answers (e.g. after reading a /en-us catalogue).
        credentials: 'omit',
        headers: { ...HEADERS, Accept: accept },
        signal: AbortSignal.timeout(20_000)
      })
      if (res.status === 429 || res.status >= 500) throw new HttpError(res.status, url)
      if (!res.ok) throw new HttpError(res.status, url)
      return await res.text()
    } catch (e) {
      const retryable = !(e instanceof HttpError) || e.status === 429 || e.status >= 500
      if (!retryable || attempt >= retries) throw e
      await sleep(1000 * 2 ** attempt * (e instanceof HttpError && e.status === 429 ? 4 : 1))
    }
  }
}

export async function fetchJson<T>(url: string): Promise<T> {
  const text = await fetchText(url, 'application/json')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Expected JSON from ${url}`)
  }
}

export async function tryFetchJson<T>(url: string): Promise<T | null> {
  try {
    return await fetchJson<T>(url)
  } catch {
    return null
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function baseUrl(input: string): string {
  const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
  return `${u.protocol}//${u.host}`
}

/** Runs tasks with bounded concurrency, preserving result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}
