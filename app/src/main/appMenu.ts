import { app, Menu, type MenuItemConstructorOptions } from 'electron'

import type { MenuCommand } from '../shared/ipc'

export interface MenuActions {
  /** Asks for Markdown files to open. */
  openFile: () => void
  /** Asks for folders to open: a document folder opens, a folder of documents joins the sidebar. */
  openFolder: () => void
  /** A command the window carries out, with the same shortcut it already answers to. */
  command: (command: MenuCommand) => void
}

/**
 * The menu bar. The window handles its own shortcuts (they work while typing in an
 * editor too), so the items it carries out show their shortcut without taking it.
 */
export function buildAppMenu(actions: MenuActions): Menu {
  const command = (label: string, id: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({
    label, accelerator, registerAccelerator: false, click: () => actions.command(id),
  })
  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: 'Open &File…', accelerator: 'CmdOrCtrl+O', click: actions.openFile },
        { label: 'Open F&older…', accelerator: 'CmdOrCtrl+Shift+O', click: actions.openFolder },
        { type: 'separator' },
        command('&Settings…', 'settings', 'CmdOrCtrl+,'),
        { type: 'separator' },
        { role: 'quit', label: 'E&xit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        command('&Sidebar', 'toggleSidebar', 'CmdOrCtrl+\\'),
        command('S&earch', 'search', 'CmdOrCtrl+Shift+F'),
        command('&Words', 'words', 'CmdOrCtrl+D'),
        command('&AI', 'ai', 'CmdOrCtrl+J'),
        { type: 'separator' },
        command('&Live Preview', 'toggleLive', 'CmdOrCtrl+/'),
        command('&Focus Mode', 'focus', 'F8'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' } as const, { role: 'reload' } as const, { role: 'toggleDevTools' } as const]),
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}
