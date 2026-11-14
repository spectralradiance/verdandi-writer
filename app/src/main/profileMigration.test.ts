import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { migrateLegacyProfile, repointPaths } from './profileMigration'

function profiles(): { legacy: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), 'verdandi-migrate-'))
  const legacy = join(root, 'Ogma')
  mkdirSync(join(legacy, 'snapshots'), { recursive: true })
  writeFileSync(join(legacy, 'settings.json'), JSON.stringify({
    workspaceRoots: ['D:\\writing'],
    dictionaryPath: join(legacy, 'wiktionary.db'),
    preferences: { appearance: { palette: 'ogma' } },
  }))
  writeFileSync(join(legacy, 'keys.json'), JSON.stringify({ ANTHROPIC_API_KEY: 'a', OGMA_COMPAT_API_KEY: 'b' }))
  writeFileSync(join(legacy, 'snapshots', 'one.json'), '{}')
  return { legacy, target: join(root, 'Verdandi Writer') }
}

describe('migrateLegacyProfile', () => {
  it('moves the old profile, repoints its paths and renames keys', () => {
    const { legacy, target } = profiles()
    expect(migrateLegacyProfile(legacy, target)).toBe('moved')
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(join(target, 'snapshots', 'one.json'))).toBe(true)
    const settings = JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8'))
    expect(settings.dictionaryPath).toBe(join(target, 'wiktionary.db'))
    expect(settings.workspaceRoots).toEqual(['D:\\writing'])
    expect(settings.preferences.appearance.palette).toBe('ogma')
    expect(Object.keys(JSON.parse(readFileSync(join(target, 'keys.json'), 'utf8')))).toEqual(['ANTHROPIC_API_KEY', 'VERDANDI_COMPAT_API_KEY'])
  })

  it('merges into a new folder Electron already made, keeping what is there', () => {
    const { legacy, target } = profiles()
    mkdirSync(target)
    writeFileSync(join(target, 'lockfile'), 'new')
    expect(migrateLegacyProfile(legacy, target)).toBe('moved')
    expect(readFileSync(join(target, 'lockfile'), 'utf8')).toBe('new')
    expect(existsSync(join(target, 'settings.json'))).toBe(true)
    expect(existsSync(legacy)).toBe(false)
  })

  it('does nothing once the new profile is in use, or with no old one', () => {
    const { legacy, target } = profiles()
    mkdirSync(target)
    writeFileSync(join(target, 'settings.json'), '{}')
    expect(migrateLegacyProfile(legacy, target)).toBe('none')
    expect(existsSync(legacy)).toBe(true)
    expect(migrateLegacyProfile(join(target, 'missing'), join(target, 'x'))).toBe('none')
  })
})

describe('repointPaths', () => {
  it('only rewrites paths inside the folder, ignoring case', () => {
    expect(repointPaths('C:\\AppData\\ogma\\db', 'C:\\AppData\\Ogma', 'C:\\AppData\\V')).toBe('C:\\AppData\\V\\db')
    expect(repointPaths('C:\\AppData\\Ogma2\\db', 'C:\\AppData\\Ogma', 'C:\\AppData\\V')).toBe('C:\\AppData\\Ogma2\\db')
  })
})
