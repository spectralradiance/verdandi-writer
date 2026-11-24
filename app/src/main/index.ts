import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, safeStorage, shell, type OpenDialogOptions } from 'electron'
import { existsSync } from 'node:fs'
import { rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { type AiConfig, type AiMessage, type AiRunRequest, type AiSettingsState, normalizeAiConfig, SECRET_NAMES, type SecretName } from '../shared/ai'
import { type DictionaryDownload, type DictionaryStatus, type ExportOptions, IPC, LOCAL_FILE_SCHEME, type LexiconEntry, type WorkspaceState, type WriteRequest } from '../shared/ipc'
import { type FieldChange, type LayerChange, layerNamesOf } from '../shared/layers'
import { pathFromLocalFileUrl } from '../shared/paths'
import { MARGIN_INCHES, normalizePreferences } from '../shared/preferences'
import { AiBridge } from './aiBridge'
import { Dictionary } from './dictionary'
import { exportMarkdown, plainLinks, writeExport } from './exporter'
import { BackupStore, PathGuard, writeTextDocument } from './fileService'
import {
  addAttachments, changeLayers, convertFileToFolder, createLayerDocument, isFolderDocument, readDocument, readViews, renameLayerDocument, restoreFolderDocument,
  saveViews, setSectionFields, trashFolderDocument, type TrashedFolder, undoConversion, writeLayerDocument,
} from './layerDocument'
import { LexiconStore } from './lexicon'
import { DEFAULT_PROMPTS, PromptStore, renderTemplate } from './prompts'
import { SearchIndex } from './searchIndex'
import { SnapshotStore } from './snapshots'
import { WritingStats } from './stats'
import { SecretStore } from './secrets'
import { SettingsStore } from './settings'
import { SidecarManager } from './sidecar'
import { resolveSidecarPaths } from './sidecarUtil'
import { buildWiktionary } from './wiktionaryBuilder'
import { LEGACY_PROFILE_NAME, migrateLegacyProfile } from './profileMigration'
import { StyleHistory } from './styleHistory'
import { WorkspaceWatcher } from './watcher'
import { buildAppMenu } from './appMenu'
import { launchCandidates, planLaunch } from './launchPaths'
import { addRoot, removeRoot, samePath } from './workspaceRoots'
import {
  createFolder, readFolder, renameFile, renameFolder, restoreFile, trashFile, type TrashedFile, validateName,
} from './workspaceService'

// Lets tests and experiments run against a throwaway profile instead of the real one.
if (process.env.VERDANDI_USER_DATA) {
  app.setPath('userData', process.env.VERDANDI_USER_DATA)
} else {
  // Before anything (the single-instance lock included) writes to the new profile folder.
  const legacyProfile = join(app.getPath('appData'), LEGACY_PROFILE_NAME)
  if (migrateLegacyProfile(legacyProfile, app.getPath('userData')) === 'failed') {
    // Most likely the old app is still running and holds files open: keep using its profile this time.
    app.setPath('userData', legacyProfile)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
// scripts/dev.ps1 -Samples opens a copy of samples/ as a workspace root.
if (process.env.VERDANDI_ADD_ROOT) {
  const roots = addRoot(settings.get().workspaceRoots, process.env.VERDANDI_ADD_ROOT, process.platform)
  if (roots !== settings.get().workspaceRoots) settings.update({ workspaceRoots: roots })
}
const secrets = new SecretStore(join(app.getPath('userData'), 'keys.json'), {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (encrypted) => safeStorage.decryptString(encrypted),
})
const sidecar = new SidecarManager(resolveSidecarPaths(app.getAppPath(), process.env, process.platform), () => ({
  ...secrets.env(),
  ...(settings.get().compatBaseUrl ? { VERDANDI_COMPAT_BASE_URL: settings.get().compatBaseUrl } : {}),
}))
const prompts = new PromptStore(join(app.getPath('userData'), 'prompts'))
const snapshots = new SnapshotStore(join(app.getPath('userData'), 'snapshots'))
const writingStats = new WritingStats(join(app.getPath('userData'), 'stats.json'))
const styleHistory = new StyleHistory(join(app.getPath('userData'), 'style-history.json'))
const ai = new AiBridge({
  connection: () => sidecar.connection(),
  prompts,
  config: () => settings.get().ai,
  historyDir: join(app.getPath('userData'), 'ai-history'),
  send: (runId, event) => mainWindow?.webContents.send(IPC.aiEvent, runId, event),
})
const guard = new PathGuard(() => settings.get().workspaceRoots)
const backupsDir = join(app.getPath('userData'), 'backups')
const backups = new BackupStore(backupsDir, guard)
const BACKUP_RETENTION_DAYS = 30
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'])
const watcher = new WorkspaceWatcher((paths) => {
  mainWindow?.webContents.send(IPC.filesChanged, paths)
  // Keep the search index current once it has been built.
  if (searchIndex?.status().ready) {
    for (const changed of paths) void searchIndex.updateFile(changed, settings.get().workspaceRoots).catch(() => {})
  }
})
let searchIndex: SearchIndex | null = null

function index(): SearchIndex {
  searchIndex ??= new SearchIndex(join(app.getPath('userData'), 'search.db'))
  return searchIndex
}

function syncIndex(): Promise<void> {
  return index().sync(settings.get().workspaceRoots, (status) => mainWindow?.webContents.send(IPC.searchProgress, status))
}

function rootsChanged(): void {
  watcher.setRoots(settings.get().workspaceRoots)
  if (searchIndex?.status().ready) void syncIndex()
}
let mainWindow: BrowserWindow | null = null
let quitting = false
let dictionary: Dictionary | null = null
let dictionaryError: string | null = null

function aiSettingsState(): AiSettingsState {
  return {
    config: settings.get().ai,
    keys: secrets.status(),
    compatBaseUrl: settings.get().compatBaseUrl,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    promptsDir: prompts.location,
  }
}

/** Renders HTML to PDF in a hidden window with scripts disabled. */
async function printToPdf(html: string): Promise<Buffer> {
  const file = join(app.getPath('temp'), `verdandi-export-${randomUUID()}.html`)
  await writeFile(file, html, 'utf8')
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } })
  try {
    await window.loadFile(file)
    const style = settings.get().preferences.export
    const margin = MARGIN_INCHES[style.margins]
    return await window.webContents.printToPDF({
      pageSize: style.pageSize,
      printBackground: true,
      margins: { top: margin, bottom: margin, left: margin, right: margin },
    })
  } finally {
    window.destroy()
    await rm(file, { force: true })
  }
}

function lexicon(): LexiconStore {
  return new LexiconStore(settings.get().lexiconDir ?? join(app.getPath('userData'), 'lexicon'))
}

/** Where to look for wiktionary.db: the saved choice, then an override. */
function dictionaryCandidates(): string[] {
  return [
    settings.get().dictionaryPath,
    process.env.VERDANDI_DICTIONARY_DB,
  ].filter((candidate): candidate is string => Boolean(candidate))
}

function openDictionary(candidates = dictionaryCandidates()): DictionaryStatus {
  dictionary?.close()
  dictionary = null
  dictionaryError = null
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      dictionary = new Dictionary(candidate)
      if (settings.get().dictionaryPath !== candidate) settings.update({ dictionaryPath: candidate })
      return dictionaryStatus()
    } catch (error) {
      dictionaryError = error instanceof Error ? error.message : String(error)
    }
  }
  dictionaryError ??= 'No wiktionary.db found. Download one or choose a file in the Words panel.'
  return dictionaryStatus()
}

function dictionaryStatus(): DictionaryStatus {
  return { available: dictionary !== null, path: dictionary ? settings.get().dictionaryPath : null, error: dictionary ? null : dictionaryError }
}

/** Recently deleted files, held so Undo can write them back. */
const trashedFiles = new Map<string, { file: TrashedFile } | { folder: TrashedFolder }>()

let dictionaryDownload: AbortController | null = null

async function downloadDictionary(): Promise<DictionaryStatus> {
  if (dictionaryDownload) throw new Error('Wiktionary is already downloading.')
  const controller = new AbortController()
  dictionaryDownload = controller
  const send = (status: DictionaryDownload) => mainWindow?.webContents.send(IPC.dictionaryDownloadProgress, status)
  const target = join(app.getPath('userData'), 'wiktionary.db')
  try {
    await buildWiktionary(target, send, controller.signal)
    const status = openDictionary([target])
    send({ state: 'done', received: 0, total: null, entries: 0, error: null })
    return status
  } catch (error) {
    const cancelled = controller.signal.aborted
    send({ state: cancelled ? 'idle' : 'error', received: 0, total: null, entries: 0, error: cancelled ? null : (error instanceof Error ? error.message : String(error)) })
    if (cancelled) return dictionaryStatus()
    throw error
  } finally {
    dictionaryDownload = null
  }
}

function requireDictionary(): Dictionary {
  if (!dictionary) openDictionary()
  if (!dictionary) throw new Error(dictionaryError ?? 'Dictionary unavailable.')
  return dictionary
}

protocol.registerSchemesAsPrivileged([
  { scheme: LOCAL_FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

function registerLocalFileProtocol(): void {
  protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
    const requested = pathFromLocalFileUrl(request.url)
    if (!requested || !IMAGE_EXTENSIONS.has(extname(requested).toLowerCase())) {
      return new Response('Not found', { status: 404 })
    }
    let target: string
    try {
      target = guard.resolve(requested)
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}

function workspaceState(): WorkspaceState {
  return { roots: settings.get().workspaceRoots, open: launchOpen }
}

/** The document named when Verdandi was started, until the window has asked for it. */
let launchOpen: string | null = null
/** Settles once the command line has been applied, so the window's first look at the workspace includes it. */
let launchReady: Promise<void> = Promise.resolve()

/** Adds the folders and files named on a command line to the workspace; returns the document to open. */
async function applyLaunch(argv: readonly string[]): Promise<string | null> {
  const skip = [process.execPath, app.getAppPath()]
  const plan = await planLaunch(settings.get().workspaceRoots, launchCandidates(argv.slice(1), process.env.VERDANDI_OPEN, skip), isFolderDocument)
  if (plan.roots.length !== settings.get().workspaceRoots.length) {
    settings.update({ workspaceRoots: plan.roots })
    rootsChanged()
  }
  return plan.open
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'Verdandi Writer',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d1c' : '#f7f6f2',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  mainWindow = window
}

function registerIpc(): void {
  ipcMain.handle(IPC.preferencesGet, () => settings.get().preferences)
  ipcMain.handle(IPC.preferencesSave, (_event, value: unknown) => {
    const preferences = normalizePreferences(value)
    settings.update({ preferences })
    // Switches prefers-color-scheme in every window, so the CSS follows.
    nativeTheme.themeSource = preferences.appearance.theme
    return preferences
  })
  ipcMain.handle(IPC.sidecarStatus, () => sidecar.getStatus())
  ipcMain.handle(IPC.sidecarLogs, () => sidecar.getLogs())
  ipcMain.handle(IPC.sidecarRestart, () => sidecar.restart())
  ipcMain.handle(IPC.sidecarStop, () => sidecar.stop())
  ipcMain.handle(IPC.sidecarInstallTorch, (_event, index: unknown) => sidecar.installTorch(text(index)))

  ipcMain.handle(IPC.workspaceGet, async () => {
    await launchReady
    const state = workspaceState()
    launchOpen = null
    return state
  })
  ipcMain.handle(IPC.workspaceAddRoot, async (event) => {
    const options: OpenDialogOptions = {
      title: 'Add folder to workspace',
      properties: ['openDirectory', 'multiSelections'],
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (!result.canceled) {
      const roots = result.filePaths.reduce(
        (current, path) => addRoot(current, path, process.platform),
        settings.get().workspaceRoots,
      )
      settings.update({ workspaceRoots: roots })
      rootsChanged()
    }
    return workspaceState()
  })
  ipcMain.handle(IPC.workspaceRemoveRoot, (_event, path: unknown) => {
    if (typeof path !== 'string') throw new TypeError('path must be a string')
    settings.update({ workspaceRoots: removeRoot(settings.get().workspaceRoots, path, process.platform) })
    rootsChanged()
    return workspaceState()
  })

  ipcMain.handle(IPC.filesRead, (_event, path: unknown, options?: { allowMissing?: boolean }) =>
    readDocument(guard.resolve(path), options?.allowMissing === true, true))
  ipcMain.handle(IPC.filesWrite, async (_event, request: WriteRequest) => {
    const target = guard.resolve(request?.path)
    const previous = await readDocument(target, true).catch(() => null)
    const before = previous && previous.mtimeMs !== null ? previous.text : null
    const result = await isFolderDocument(target)
      ? await writeLayerDocument(target, request, backups)
      : await writeTextDocument(target, request, backups)
    if (result.ok) {
      void snapshots.afterSave(target, request.text).catch(() => {})
      writingStats.recordSave(before, request.text, layerNamesOf(previous))
      try {
        styleHistory.recordSave(target, before, request.text, layerNamesOf(previous))
      } catch {
        // the history is a convenience; a save never fails because of it
      }
      mainWindow?.webContents.send(IPC.statsChanged, writingStats.daily())
    }
    return result
  })
  ipcMain.handle(IPC.statsDocument, (_event, folder: unknown) => writingStats.documentStats(guard.resolve(folder)))
  ipcMain.handle(IPC.statsSetGoal, (_event, folder: unknown, words: unknown) => {
    const target = guard.resolve(folder)
    writingStats.setGoal(target, typeof words === 'number' && Number.isFinite(words) ? words : null)
    return writingStats.documentStats(target)
  })
  ipcMain.handle(IPC.statsStyle, async (_event, file: unknown) => {
    const target = guard.resolve(file)
    const document = await readDocument(target, true)
    return styleHistory.report(target, document.text, layerNamesOf(document))
  })
  ipcMain.handle(IPC.statsDaily, (_event, days: unknown) => writingStats.daily(typeof days === 'number' ? Math.min(Math.max(days, 1), 366) : 14))
  ipcMain.handle(IPC.historyList, (_event, file: unknown) => snapshots.list(guard.resolve(file)))
  ipcMain.handle(IPC.historyRead, (_event, file: unknown, id: unknown) => snapshots.read(guard.resolve(file), text(id)))
  ipcMain.handle(IPC.historySnapshot, (_event, file: unknown, content: unknown, label: unknown) =>
    snapshots.manual(guard.resolve(file), text(content), typeof label === 'string' ? label : ''))

  ipcMain.handle(IPC.foldersRename, async (_event, folder: unknown, name: unknown) => {
    const source = guard.resolve(folder)
    const target = await renameFolder(source, text(name))
    const roots = settings.get().workspaceRoots
    if (roots.some((root) => samePath(root, source, process.platform))) {
      settings.update({ workspaceRoots: roots.map((root) => (samePath(root, source, process.platform) ? target : root)) })
      rootsChanged()
    }
    return target
  })
  ipcMain.handle(IPC.foldersRead, async (_event, folder: unknown) => {
    const target = guard.resolve(folder)
    return { ...await readFolder(target), document: await isFolderDocument(target) }
  })
  ipcMain.handle(IPC.foldersCreate, (_event, parent: unknown, name: unknown) =>
    createFolder(guard.resolve(parent), text(name)))
  ipcMain.handle(IPC.dictionaryStatus, () => (dictionary ? dictionaryStatus() : openDictionary()))
  ipcMain.handle(IPC.dictionaryChoose, async (event) => {
    const options: OpenDialogOptions = {
      title: 'Choose wiktionary.db',
      properties: ['openFile'],
      filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }],
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled ? dictionaryStatus() : openDictionary([result.filePaths[0]])
  })
  ipcMain.handle(IPC.dictionaryDownload, () => downloadDictionary())
  ipcMain.handle(IPC.dictionaryCancelDownload, () => dictionaryDownload?.abort())
  ipcMain.handle(IPC.dictionaryLookup, (_event, word: unknown) => requireDictionary().lookup(text(word)))
  ipcMain.handle(IPC.dictionarySearch, (_event, query: unknown, limit: unknown) =>
    requireDictionary().search(text(query), typeof limit === 'number' ? limit : 20))

  ipcMain.handle(IPC.lexiconLocation, () => lexicon().location)
  ipcMain.handle(IPC.lexiconList, () => lexicon().list())
  ipcMain.handle(IPC.lexiconSave, (_event, entry: LexiconEntry) => {
    if (!entry || typeof entry.word !== 'string') throw new TypeError('Expected a lexicon entry.')
    return lexicon().save(entry)
  })
  ipcMain.handle(IPC.lexiconRemove, (_event, word: unknown) => lexicon().remove(text(word), (file) => shell.trashItem(file)))
  ipcMain.handle(IPC.lexiconImportAisling, async (event) => {
    const options: OpenDialogOptions = { title: 'Choose Aisling’s Vocabulary folder', properties: ['openDirectory'] }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : lexicon().importAisling(result.filePaths[0])
  })

  ipcMain.handle(IPC.exportDocument, async (event, folder: unknown, title: unknown, options: ExportOptions) => {
    const source = guard.resolve(folder)
    const content = options?.content
    const validContent = content === 'output' || content === 'notes' || (typeof content === 'string' && /^layer:[a-z0-9-]+$/.test(content))
    if (!options || !['md', 'html', 'pdf'].includes(options.format) || !validContent) {
      throw new TypeError('Invalid export options.')
    }
    const name = text(title).replace(/[<>:"/\\|?*]/g, '_') || 'document'
    const suffix = content === 'notes' ? ' (notes)' : content.startsWith('layer:') ? ` (${content.slice('layer:'.length).replace(/-/g, ' ')})` : ''
    const dialogOptions = {
      title: 'Export document',
      defaultPath: join(app.getPath('documents'), `${name}${suffix}.${options.format}`),
      filters: [{ name: options.format.toUpperCase(), extensions: [options.format] }],
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const choice = owner ? await dialog.showSaveDialog(owner, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
    if (choice.canceled || !choice.filePath) return null
    const document = await readDocument(source)
    const names = layerNamesOf(document)
    if (content.startsWith('layer:') && !(names ?? ['notes']).includes(content.slice('layer:'.length))) {
      throw new TypeError('The document has no such layer.')
    }
    // A document folder's images are inside it (in `attachments/`, where Obsidian puts them); a file's are beside it.
    const base = document.folder ? source : dirname(source)
    const exported = exportMarkdown(document.text, text(title), options, names)
    const markdown = plainLinks(exported.markdown, (image) => (existsSync(join(base, 'attachments', image)) ? `attachments/${image}` : image))
    const { sections, skipped } = exported
    await writeExport(choice.filePath, options.format, markdown, text(title), base, printToPdf, settings.get().preferences.export)
    return { path: choice.filePath, sections, skipped }
  })
  ipcMain.handle(IPC.exportShow, (_event, file: unknown) => shell.showItemInFolder(text(file)))

  ipcMain.handle(IPC.searchStatus, () => index().status())
  ipcMain.handle(IPC.searchSync, async () => {
    await syncIndex()
    return index().status()
  })
  ipcMain.handle(IPC.searchQuery, (_event, query: unknown) => index().search(text(query)))
  ipcMain.handle(IPC.searchRelated, (_event, passage: unknown, exclude: unknown) =>
    index().related(text(passage), Array.isArray(exclude) ? exclude.filter((item): item is string => typeof item === 'string') : []))

  ipcMain.handle(IPC.aiSettings, () => aiSettingsState())
  ipcMain.handle(IPC.aiSaveConfig, (_event, config: AiConfig) => {
    settings.update({ ai: normalizeAiConfig(config) })
    return aiSettingsState()
  })
  ipcMain.handle(IPC.aiSetKey, async (_event, name: unknown, value: unknown) => {
    if (!SECRET_NAMES.includes(name as SecretName)) throw new TypeError('Unknown key name.')
    secrets.set(name as SecretName, typeof value === 'string' ? value : null)
    await sidecar.restart()
    return aiSettingsState()
  })
  ipcMain.handle(IPC.aiSetCompatBaseUrl, async (_event, url: unknown) => {
    const value = text(url).trim()
    if (value && !/^https?:\/\//i.test(value)) throw new Error('The base URL must start with http:// or https://')
    settings.update({ compatBaseUrl: value })
    await sidecar.restart()
    return aiSettingsState()
  })
  ipcMain.handle(IPC.aiOpenPrompts, async () => {
    await prompts.ensureDefaults()
    await shell.openPath(prompts.location)
  })
  ipcMain.handle(IPC.aiRun, (_event, request: AiRunRequest) => {
    if (!request || typeof request.task !== 'string' || typeof request.variables !== 'object') throw new TypeError('Expected an AI run request.')
    const messages = (list: unknown) => list === undefined || (Array.isArray(list) && list.every((message: Partial<AiMessage> | null) =>
      (message?.role === 'user' || message?.role === 'assistant') && (typeof message.content === 'string' || Array.isArray(message.content))))
    if (!messages(request.history) || !messages(request.continuation)) throw new TypeError('Expected the chat history as a list of messages.')
    if (request.tools !== undefined && !Array.isArray(request.tools)) throw new TypeError('Expected a list of tools.')
    return ai.start(request)
  })
  ipcMain.handle(IPC.aiCancel, (_event, runId: unknown) => ai.cancel(text(runId)))
  ipcMain.handle(IPC.aiRender, async (_event, task: unknown, variables: unknown) => {
    if (typeof task !== 'string' || !(task in DEFAULT_PROMPTS) || typeof variables !== 'object' || variables === null) {
      throw new TypeError('Expected a task and its variables.')
    }
    return renderTemplate(await prompts.template(task as AiRunRequest['task']), variables as Record<string, string>)
  })
  ipcMain.handle(IPC.aiUnloadLocal, async () => {
    const connection = sidecar.connection()
    if (!connection) return
    await fetch(`${connection.baseUrl}/ai/local/unload`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}` } })
  })

  ipcMain.handle(IPC.filesRename, async (_event, file: unknown, name: unknown) => {
    const target = guard.resolve(file)
    return (await isFolderDocument(target)) ? renameLayerDocument(target, text(name).trim()) : renameFile(target, text(name))
  })
  ipcMain.handle(IPC.filesTrash, async (_event, file: unknown) => {
    const target = guard.resolve(file)
    const trash = (item: string) => shell.trashItem(item)
    const trashed = (await isFolderDocument(target))
      ? { folder: await trashFolderDocument(target, trash) }
      : { file: await trashFile(target, trash) }
    const undoId = randomUUID()
    trashedFiles.set(undoId, trashed)
    if (trashedFiles.size > 20) trashedFiles.delete(trashedFiles.keys().next().value as string)
    return { undoId }
  })
  ipcMain.handle(IPC.filesRestore, async (_event, undoId: unknown) => {
    const entry = trashedFiles.get(text(undoId))
    if (!entry) throw new Error('That deletion can no longer be undone.')
    if ('folder' in entry) await restoreFolderDocument(entry.folder)
    else await restoreFile(entry.file)
    trashedFiles.delete(text(undoId))
  })
  ipcMain.handle(IPC.documentsCreate, async (_event, parent: unknown, name: unknown) => {
    const error = validateName(text(name))
    if (error) throw new Error(error)
    return createLayerDocument(guard.resolve(parent), text(name).trim())
  })
  ipcMain.handle(IPC.documentsConvert, async (_event, file: unknown) => {
    const converted = await convertFileToFolder(guard.resolve(file))
    return converted.folder
  })
  ipcMain.handle(IPC.documentsUndoConvert, (_event, folder: unknown) => undoConversion(guard.resolve(folder), (item) => shell.trashItem(item)))
  ipcMain.handle(IPC.documentsChangeLayers, (_event, folder: unknown, change: LayerChange) => {
    if (!change || typeof change !== 'object') throw new TypeError('change must be an object')
    return changeLayers(guard.resolve(folder), change, backups, (item) => shell.trashItem(item))
  })
  ipcMain.handle(IPC.documentsSetFields, (_event, folder: unknown, id: unknown, change: unknown, expected: unknown) => {
    if (typeof id !== 'string' || !id) throw new TypeError('id must be a section id')
    const value = change as Partial<FieldChange> | null
    if (!value || typeof value.set !== 'object' || value.set === null || Array.isArray(value.set) || !Array.isArray(value.remove)) {
      throw new TypeError('change must be { set, remove }')
    }
    const remove = value.remove.filter((key): key is string => typeof key === 'string')
    return setSectionFields(guard.resolve(folder), id, { set: value.set, remove }, typeof expected === 'number' ? expected : null, backups)
  })
  ipcMain.handle(IPC.documentsReadViews, (_event, folder: unknown) => readViews(guard.resolve(folder)))
  ipcMain.handle(IPC.documentsSaveViews, (_event, folder: unknown, views: unknown) => saveViews(guard.resolve(folder), views))
  // Images come from anywhere the user picks or drops them; only image files are copied, and only into the document.
  ipcMain.handle(IPC.documentsAddImages, async (event, folder: unknown, files: unknown) => {
    const target = guard.resolve(folder)
    let sources = Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string' && file.length > 0) : null
    if (!sources) {
      const options: OpenDialogOptions = {
        title: 'Add images',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS].map((extension) => extension.slice(1)) }],
      }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
      if (result.canceled) return []
      sources = result.filePaths
    }
    return addAttachments(target, sources)
  })
  ipcMain.handle(IPC.filesReveal, async (_event, target: unknown) => {
    const resolved = guard.resolve(target)
    if ((await stat(resolved)).isDirectory()) {
      const error = await shell.openPath(resolved)
      if (error) throw new Error(error)
    } else {
      shell.showItemInFolder(resolved)
    }
  })
  ipcMain.handle(IPC.foldersTrash, async (_event, folder: unknown) => {
    const resolved = guard.resolve(folder)
    if (settings.get().workspaceRoots.some((root) => samePath(root, resolved, process.platform))) {
      throw new Error('This is a workspace folder. Use “Remove from workspace” instead; its files are not touched.')
    }
    if (!(await stat(resolved)).isDirectory()) throw new Error('That is not a folder.')
    await shell.trashItem(resolved)
  })
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected a string.')
  return value
}

sidecar.on('status', (status) => {
  mainWindow?.webContents.send(IPC.sidecarStatusChanged, status)
})

/**
 * Opens folders and files in the running window: folders join the workspace (a
 * document folder also opens), and a file opens with its folder in the workspace.
 */
async function openPaths(paths: readonly string[]): Promise<void> {
  const window = mainWindow
  if (!window || paths.length === 0) return
  const plan = await planLaunch(settings.get().workspaceRoots, paths, isFolderDocument)
  if (plan.roots.length !== settings.get().workspaceRoots.length) {
    settings.update({ workspaceRoots: plan.roots })
    rootsChanged()
  }
  window.webContents.send(IPC.workspaceChanged, { roots: settings.get().workspaceRoots, open: plan.open })
}

/** The Open File… and Open Folder… dialogs of the menu bar. */
async function chooseAndOpen(kind: 'file' | 'folder'): Promise<void> {
  const window = mainWindow
  if (!window) return
  const options: OpenDialogOptions = kind === 'file'
    ? { title: 'Open file', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }, { name: 'All files', extensions: ['*'] }] }
    : { title: 'Open folder', properties: ['openDirectory', 'multiSelections'] }
  const result = await dialog.showOpenDialog(window, options)
  if (!result.canceled) await openPaths(result.filePaths)
}

app.on('second-instance', (_event, argv) => {
  if (!mainWindow) return
  // Started again with something to open: VERDANDI_OPEN belongs to the first start, so only the arguments count.
  void openPaths(launchCandidates(argv.slice(1), undefined, [process.execPath, app.getAppPath()]))
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// will-quit fires only after every window has closed, i.e. after the renderer has
// flushed unsaved edits, so the sidecar is not stopped if a window refuses to close.
app.on('will-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  watcher.close()
  dictionary?.close()
  searchIndex?.close()
  void sidecar.stop().finally(() => app.quit())
})

void app.whenReady().then(() => {
  nativeTheme.themeSource = settings.get().preferences.appearance.theme
  registerLocalFileProtocol()
  registerIpc()
  Menu.setApplicationMenu(buildAppMenu({
    openFile: () => void chooseAndOpen('file'),
    openFolder: () => void chooseAndOpen('folder'),
    command: (command) => mainWindow?.webContents.send(IPC.menuCommand, command),
  }))
  void BackupStore.prune(backupsDir, BACKUP_RETENTION_DAYS)
  launchReady = applyLaunch(process.argv).then((open) => {
    launchOpen = open
  }, () => {})
  void prompts.ensureDefaults()
  createWindow()
  watcher.setRoots(settings.get().workspaceRoots)
  void sidecar.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
