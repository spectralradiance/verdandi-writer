// Per-machine view preferences. Storage can be unavailable, so every access is guarded.

const PREFIX = 'verdandi.'
/** The prefix used before the app was renamed; values saved under it are read once and moved. */
const LEGACY_PREFIX = 'ogma.'

export function readPref(key: string): string | null {
  try {
    const value = window.localStorage.getItem(PREFIX + key)
    if (value !== null) return value
    const legacy = window.localStorage.getItem(LEGACY_PREFIX + key)
    if (legacy !== null) {
      window.localStorage.setItem(PREFIX + key, legacy)
      window.localStorage.removeItem(LEGACY_PREFIX + key)
    }
    return legacy
  } catch {
    return null
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    window.localStorage.removeItem(LEGACY_PREFIX + key)
    if (value === null) window.localStorage.removeItem(PREFIX + key)
    else window.localStorage.setItem(PREFIX + key, value)
  } catch {
    // preferences are a convenience only
  }
}
