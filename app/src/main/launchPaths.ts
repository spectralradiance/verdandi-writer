import { stat } from 'node:fs/promises'
import path from 'node:path'

import { addRoot, samePath } from './workspaceRoots'

/**
 * What Verdandi was asked to open when it started (or when it was started again
 * while running): folders and Markdown files named on the command line, or in
 * `VERDANDI_OPEN` (separated like PATH). Flags, the executable and the app's own
 * folder are skipped, as is anything that doesn't exist.
 */
export function launchCandidates(argv: readonly string[], env: string | undefined, skip: readonly string[]): string[] {
  const named = [...argv.filter((arg) => !arg.startsWith('-')), ...(env ? env.split(path.delimiter) : [])]
  return named.map((arg) => arg.trim()).filter((arg) => arg && path.isAbsolute(arg) && !skip.some((other) => samePath(other, arg, process.platform)))
}

export interface LaunchPlan {
  /** The workspace folders, with each folder named added (a file's own folder for a file). */
  roots: string[]
  /** What to open in the editor: the first document named. */
  open: string | null
}

/**
 * Adds what was named to the workspace and picks the document to open: a folder
 * that is a document, or a Markdown file. A folder of documents is only added.
 */
export async function planLaunch(
  roots: readonly string[], candidates: readonly string[], isDocument: (folder: string) => Promise<boolean>,
): Promise<LaunchPlan> {
  let next = [...roots]
  let open: string | null = null
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null)
    if (!info) continue
    if (info.isDirectory()) {
      next = addRoot(next, candidate, process.platform)
      if (open === null && await isDocument(candidate)) open = candidate
    } else if (/\.(md|markdown)$/i.test(candidate)) {
      const folder = path.dirname(candidate)
      // A main file opens as its document folder.
      const document = await isDocument(folder) && samePath(path.join(folder, `${path.basename(folder)}.md`), candidate, process.platform)
      if (!next.some((root) => samePath(root, folder, process.platform) || isInside(candidate, root))) next = addRoot(next, folder, process.platform)
      if (open === null) open = document ? folder : candidate
    }
  }
  return { roots: next, open }
}

function isInside(file: string, folder: string): boolean {
  const relative = path.relative(folder, file)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
