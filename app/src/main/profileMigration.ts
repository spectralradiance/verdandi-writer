import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The app was called Ogma before it became Verdandi Writer; its profile folder had that name. */
export const LEGACY_PROFILE_NAME = 'Ogma'
/** Stored key names that changed with the rename. */
const RENAMED_SECRETS: Record<string, string> = { OGMA_COMPAT_API_KEY: 'VERDANDI_COMPAT_API_KEY' }

export type MigrationResult = 'none' | 'moved' | 'failed'

/**
 * Moves the profile from the app's old name to its new one, once. The new profile counts as
 * in use as soon as it has a settings.json, which is moved last, so an interrupted move
 * carries on at the next launch. Paths in settings.json that pointed inside the old folder
 * (such as the dictionary) are pointed at the new one.
 */
export function migrateLegacyProfile(legacy: string, target: string): MigrationResult {
  if (!existsSync(legacy) || existsSync(join(target, 'settings.json'))) return 'none'
  try {
    if (!existsSync(target)) {
      renameSync(legacy, target)
    } else {
      // Electron may already have made the new folder (a lock file, caches): move entries in beside it.
      const entries = readdirSync(legacy).sort((left, right) => Number(left === 'settings.json') - Number(right === 'settings.json'))
      for (const entry of entries) {
        if (!existsSync(join(target, entry))) renameSync(join(legacy, entry), join(target, entry))
      }
      if (readdirSync(legacy).length === 0) rmdirSync(legacy)
    }
  } catch {
    return 'failed'
  }
  rewriteJson(join(target, 'settings.json'), (value) => repointPaths(value, legacy, target))
  rewriteJson(join(target, 'keys.json'), renameSecrets)
  return 'moved'
}

/** Replaces a leading `from` folder with `to` in every string, keeping what follows it. */
export function repointPaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') {
    const base = from.replace(/[\\/]+$/, '')
    const matches = value.length >= base.length
      && value.slice(0, base.length).toLowerCase() === base.toLowerCase()
      && (value.length === base.length || /[\\/]/.test(value[base.length]))
    return matches ? to + value.slice(base.length) : value
  }
  if (Array.isArray(value)) return value.map((item) => repointPaths(item, from, to))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, repointPaths(item, from, to)]))
  }
  return value
}

function renameSecrets(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [RENAMED_SECRETS[key] ?? key, item]))
}

function rewriteJson(path: string, change: (value: unknown) => unknown): void {
  if (!existsSync(path)) return
  try {
    writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, 'utf8'))), null, 2), 'utf8')
  } catch {
    // A file that cannot be read is left alone; the stores fall back to defaults as before.
  }
}
