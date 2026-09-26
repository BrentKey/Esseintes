const LOOKS_LIKE_SITE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i

/** Accepts our own JSON export, or any text/CSV with one or more web addresses. */
export function parseStoreList(text: string): { url: string; name?: string }[] {
  try {
    const data = JSON.parse(text)
    const list = Array.isArray(data) ? data : data?.stores
    if (Array.isArray(list))
      return list
        .filter((s) => typeof s?.url === 'string')
        .map((s) => ({ url: s.url, name: typeof s.name === 'string' ? s.name : undefined }))
  } catch {
    /* not JSON: treat as plain text */
  }
  return text
    .split(/[\s,;"']+/)
    .filter((t) => LOOKS_LIKE_SITE.test(t))
    .map((url) => ({ url }))
}
