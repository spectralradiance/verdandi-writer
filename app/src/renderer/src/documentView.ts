// The view each document is shown with now, kept in the app's preferences (the
// saved views of a document folder are in its `.verdandi/views.yaml`).

import { type DocumentView, normalizeView } from '../../shared/views'
import { readPref, writePref } from './prefs'

const key = (path: string) => `view:${path.toLowerCase()}`

/**
 * The view `path` was last shown with. A document seen for the first time starts
 * from the app-wide choice of the two-column view it replaced: the text or the
 * notes first, and the other side shown or not.
 */
export function loadView(path: string, layers: readonly string[]): DocumentView {
  const stored = readPref(key(path))
  if (stored !== null) {
    try {
      return normalizeView(JSON.parse(stored), layers)
    } catch {
      // fall through to the defaults
    }
  }
  const legacy = readPref('notesView')
  const primary = (readPref('primary') ?? legacy) === 'notes' && layers.includes('notes') ? 'notes' : 'output'
  const secondary = readPref('secondary')
  const sideShown = secondary !== null ? secondary !== 'false' : legacy === null || legacy === 'all'
  return { ...normalizeView({ primary }, layers), sideHidden: !sideShown && layers.length > 0 }
}

export function storeView(path: string, view: DocumentView): void {
  writePref(key(path), JSON.stringify(view))
}
