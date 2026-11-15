# Verdandi Writer

A Markdown editor for writing, vocabulary and linguistic research. See [PLAN.md](PLAN.md) for the design and roadmap.

Verdandi is one of three Norn apps: **Urdr Reader** is for reading (highlights from it land in your notes) and **Skuldr Social** for publishing (finished drafts go there as pages or stories).

- `app/`: Electron + React + TypeScript desktop app
- `sidecar/`: Python FastAPI server for AI and GPU work, launched by the app
- `scripts/`: setup and dev helpers

## Setup (Windows, PowerShell)

Requires Node.js 22+ and Python 3.11+.

```powershell
.\scripts\setup-sidecar.ps1           # venv + FastAPI + CUDA PyTorch (cu126)
.\scripts\setup-sidecar.ps1 -NoTorch  # skip the ~2.5 GB PyTorch download for now
cd app; npm install                   # also downloads the Electron binary
```

## Run

```powershell
.\scripts\dev.ps1               # the app; it starts and stops the sidecar itself
.\scripts\dev.ps1 -SidecarOnly  # just the sidecar on :8765, printing its token
```

The status bar shows the sidecar state, GPU memory, PyTorch/CUDA and which AI providers have keys. Click it for details, logs and a restart button.

API keys are set in the app under **AI → ⚙ AI settings → Keys** (stored encrypted). Keys already in the environment the app starts from (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) also work; keys saved in the app take precedence.

## Samples

`samples/` holds example documents: *The Night Sky* (four sections with notes; one has notes only), *Winter Notebook* and *Field Journal*. Add the folder with **+** in the sidebar and try the Text and Notes views.

## Documents

A document is a folder that Obsidian can open as part of a vault. The **document note**, named after the folder, lists the sections in order as embeds, so reading it in Obsidian shows the whole document. Each section is one Markdown file named after it. The file's body is the section's text, and its notes are `> [!notes]` callouts after the paragraphs they belong to:

```
Eras/
  Eras.md              ← ---  verdandi: document, layers: [notes]  ---  then ![[The First Era]] …
  The First Era.md     ← ---  id: 7f3a  ---  then the text, and > [!notes] callouts
  .verdandi/           ← saved views (views.yaml), and the original file if the document was converted
```

**Layers.** Every section of a document has the same layers: its text, plus the layers the document note declares (notes to begin with). Add, rename or delete layers with **Layers → Manage layers…** in the header (or **Layers…** in a section's ⋯ menu). Each is a callout type on disk, such as `> [!outline]`, and an empty one is not written. Renaming a layer rewrites its callouts in every section file; deleting one that has anything in it asks first and keeps an earlier version in History. A layer's kind (prose, list or gallery) and whether it is anchored to paragraphs are recorded in the note; for now every kind is edited as Markdown.

The sidebar lists a document folder as one document. Renaming a section renames its file (the exact title goes in the file's frontmatter when it can't be a file name), and the document note follows. Moving a section reorders the embeds. Splitting a section makes a new file, merging moves its text into the section above, and deleting it moves its file to the Recycle Bin. Only the files whose section changed are written. Files edited in Obsidian are picked up as they change, and a section file added to the document note in Obsidian becomes a section. **Show name as a heading** is a setting of the file (`heading: false` when it is off): exports show the name as a heading or leave it out.

**Older one-file documents** convert when they're opened. A file that uses notes blocks or section markers (below) becomes a document folder next to where it was: one file per section, with any text before the first heading as "Introduction". The original file is kept in the folder's `.verdandi/original/`, and the notice that appears offers **Undo**, which puts the file back. The file then stays a single file for the rest of the session. Any other Markdown file, such as an ordinary Obsidian note, opens **read-only**, with a **Make this a document** button.

The rest of this section describes the one-file format, which is how older documents are written, and how a file whose conversion was undone keeps working. Each `#` heading starts a section (the outline lists them; `##` and deeper stay inside their section), and a section's notes sit under its text in a notes block:

```
# First Light

The text of the section.

::: notes
Working notes, research and fragments for this section.
:::
```

A section can also have a name without a heading: a `<!-- section: The turn -->` line starts it. The name labels the row and the outline but is not part of the text, so exports leave it out. A heading right under such a line belongs to that section.

The document is shown as rows, one per section. Each row starts with its **primary** layer, and the other layers the view shows sit beside it as panels. The buttons at the left of the header choose the primary layer: **Text view** puts each section's text first, **Notes view** its notes (under the section's heading), and each other layer has a view of its own. The layer that was first moves beside the new one. The **Layers** menu chooses which layers show beside each section and whether they sit **side by side** or **stacked** under it.

**Views.** Each section's ⋯ menu can **open it on its own page** (all its layers one under another, with arrows to the next and previous section), **collapse** it to its name (the arrows beside the name expand it again), or **hide it from this view**. The **Views** menu filters the sections by their fields (frontmatter such as `status: draft` or `tags: [act-1]`, which can be added in Obsidian), shows hidden sections again, and saves the view under a name. Saved views are kept in the document's `.verdandi/views.yaml`, so they travel with it; choosing one restores which layers show and how, the filter, and the hidden, collapsed or paged sections. The view a document was last shown with is remembered on this computer.

On a wide window the primary side is on the left and the secondary on the right; on a narrow one (a phone, or a window squeezed by the side panels) they stack, primary on top. A row is as tall as its primary text, and the secondary side scrolls within it. Drag a row's bottom edge to make it taller or shorter (both sides then scroll); double-click the edge to fit the text again. The side panels can be hidden for one section (the eye icon on the first, or the icon at the row's right edge to bring them back) or for the whole document (the columns button in the header, which also resets the per-section choices). Heights and per-section choices are remembered for each file.

Each section has a **⋯ menu** (at the top right of the row): **Rename section**, **Show name as a heading** (switch between a heading in the text and a name only), **Move up** / **Move down**, **Merge into** the section above (its heading becomes a subheading; a name is dropped), **Merge the next section into this**, **New section from this paragraph**, hide or show the other side, fit the height to the text, and **Delete section…** (an earlier version is kept in History). To start a named section at any paragraph, put the cursor in it and press **Ctrl+Alt+S**, then type the name: the new section starts at the line the cursor is on (paragraphs need not be separated by blank lines) and runs to the end of the section. With text selected, only the selected paragraphs become the new section, and the text after them continues as "Name (continued)", so nothing moves. A section is never left with only its heading.

Edits on either side go straight into the file: notes typed for a section without any start a `::: notes` block at its end, and existing blocks stay where they are in the text. A heading or notes markers typed into a side are sorted into rows when you leave it. **Ctrl+Alt+N** moves round a section's text and the layers shown beside it (showing them if they are hidden), and the arrow keys move on to the next or previous section at the end of one. Headings inside notes never start a section. Word counts keep notes apart (the status bar shows "N in notes"), exports leave notes out (or export only the notes), AI Analyze ignores them, and **Draft output from notes** drafts the section at the cursor from its notes.

**New document** (folder right-click, or the + on a folder) makes a document folder with one empty section, "Introduction".

## Working in the sidebar

The sidebar shows the workspace folders with their subfolders and documents. To reorder, merge or rename sections, use each section's ⋯ menu in the editor.

- **Rename** a document or folder by double-clicking it (or right-click → Rename). A renamed document stays open, and so do open files inside a renamed folder.
- **Right-click** a document for Rename and Delete; right-click a folder for New document, New folder, Rename and (for top-level folders) Remove from workspace.
- **Delete** doesn't ask first. A toast offers **Undo** for 10 seconds; the file also goes to the Recycle Bin. Undo works until the app closes, for the last 20 deletions.

## Dictionary

The Words panel (Ctrl+D) reads a local `wiktionary.db`. If none is found, click **Download Wiktionary** in the panel: it downloads the English Wiktionary extract from kaikki.org (about 500 MB compressed), builds the database in `%APPDATA%\Verdandi Writer\wiktionary.db` (roughly 1 GB) and starts using it. You can cancel at any time. **Choose an existing wiktionary.db…** points the app at one you already have.

## Appearance

**Settings** (status bar) has a color scheme (match Windows, light or dark) and a palette: Ogma, Parchment, Slate or Mono. Each palette has a light and a dark variant. Palettes are sets of CSS variables under `[data-palette]` in `app/src/renderer/src/styles.css`, so adding one means a new block there and an entry in `PALETTES` in `app/src/shared/preferences.ts`. The UI is built with Tailwind CSS (utilities read the same variables), Radix UI for menus and dialogs, and Lucide icons.

## AI

Open the **AI** panel (button in the document header, or Ctrl+J). It has two views, **Tools** and **Chat**, and remembers which one you last used.

**Tools** are one-shot tasks:

- **Draft output from notes** — for the section at the cursor, drafts its text from its notes, its current text and the notes before the first section (outline, sources). When it finishes, the draft appears in that section's editor as suggested changes, word by word where a paragraph was edited and whole where it was rewritten. Deletions are struck through and insertions highlighted, each with ✓ / ✕; the bar above the editor has **Next**, **Reject all** and **Accept all**. Nothing changes until you accept, and Ctrl+Z undoes an accept or reject (bringing the suggestion back). Keep writing meanwhile: suggestions follow the text, and one you type over is dropped. The text as it was before the draft is saved to History first, labelled "Before AI: …". **Suggest again** in the AI panel re-places the draft if you dismissed it or the editor was closed.
- **Analyze** — the selection or the focused file: local measurements (reading ease, sentence length and spread, repeated words) plus the model's notes on tone, structure, readability and style.
- **Analyze structure** — order, balance, gaps and overlaps across the whole document, from its outline, section sizes and opening lines.
- **Word choice** — alternatives for the word at the cursor; ↵ replaces it.

**Chat** is a conversation about your work: feedback, ideas, wording. **Enter** sends and **Shift+Enter** starts a new line. With **Attach focused text** on, each message includes the selection, or the whole focused file if nothing is selected (up to about 24,000 characters; inline notes blocks are left out), along with the document and section names. The model sees the whole conversation. The conversation stays put when you switch drawers or close the panel, and keeps streaming meanwhile; **New chat** clears it, and so does reloading the window. Chat follows the same model picker, mode and routing as the tools.

With **Agent** on, the chat can act on your work: ask it to tighten a section, check the piece for consistency, or carry a change through every section. It works in steps, using tools to list the open files, read them (unsaved edits included), read the outline, and search the workspace, then suggests edits. Each tool it uses shows as a line in its reply. Edits are never written directly: they appear in the editor as suggestions, exactly like a draft, so you accept or reject each one. It can only edit files that are open, and the first edit to a file in each answer saves a "Before AI" version to History. **Stop** ends it after the current step, and it stops on its own after 30 steps. Agent mode needs a model that can use tools: Claude, OpenAI or an OpenAI-compatible host (Settings → Routing → Agent); Gemini and the local model are skipped.

Set up providers under **⚙ AI settings**:

- **Keys** — Anthropic, OpenAI, Gemini, and an optional OpenAI-compatible host (base URL + key; works for OpenRouter-style hosts or a local LM Studio/Ollama server). Keys are encrypted with Windows (DPAPI) and passed only to the local AI server.
- **Models** — profiles (provider + model id). Claude defaults to `claude-opus-5`; OpenAI/Gemini/compatible profiles need a model id. **Test** checks one profile with no fallback.
- **Routing** — the order each task tries models in. **Local / Hybrid / Cloud** filters that list; unavailable models are skipped, and a model that fails before writing anything falls back to the next.
- **Prompts** — each task's prompt is an editable Markdown file. In `chat.md` the part above `=== user ===` is the system prompt (with `{{document}}`, `{{section}}` and `{{context}}`), and `{{message}}` is the message you type; earlier turns are sent before it. `agent.md` works the same way for agent mode, but keep its system part free of placeholders: it is resent unchanged with every step.

The local model needs PyTorch and the transformers stack: run `.\scripts\setup-sidecar.ps1` without `-NoTorch`. The first local run downloads the model (Qwen 2.5 7B by default, several GB) and needs an NVIDIA GPU; it loads in 4-bit and unloads after 10 idle minutes.

Every run is logged (task, model, token usage, input hash, output) to `%APPDATA%\Verdandi Writer\ai-history\<month>.jsonl`.

## Finding, exporting and tracking

- **Search** (sidebar tab, Ctrl+Shift+F) looks through every text file in the workspace folders. The index is built the first time you open Search and then kept current as files change. *Related to the current passage* lists paragraphs elsewhere that share the focused passage's key words.
- **Export** (Settings → Export, Ctrl+,) writes the open document's text without its notes, or only its notes, as PDF, HTML or Markdown.
- **History** (⟲ on any editor) lists earlier versions of that file — saved automatically at most every 10 minutes while you edit, plus snapshots you take and a "Before AI" version whenever the AI suggests changes — with a diff against the current text and Restore. Versions are kept in `%APPDATA%\Verdandi Writer\snapshots`, never in your folders.
- **Stats** (chart button in the document header) shows text and notes word counts per section, a word goal with progress, and words written per day; today's net count is in the status bar.

## Editing safety

Files are edited in place, so saving is careful:

- The encoding (UTF-8, UTF-8 BOM, UTF-16, Windows-1252) and line endings are detected on open and restored on save. Unchanged files round-trip byte for byte. If you type a character Windows-1252 can't store, the file is saved as UTF-8 and a notice says so.
- Saves are atomic (temp file + rename) and autosave runs 1.2 s after you stop typing, on blur, when switching files and on close.
- Before Verdandi Writer first overwrites a file in a session, it copies the original to `%APPDATA%\Verdandi Writer\backups\<session>\`. Backups older than 30 days are pruned.
- If the file changed on disk since it was opened, Verdandi Writer stops and asks: load the disk version, or keep yours.

Set `VERDANDI_USER_DATA` to a folder to run against a throwaway profile (settings, backups) instead of your real one.

The app keeps its settings, keys, history and dictionary in `%APPDATA%\Verdandi Writer`. On first launch it moves the profile over from `%APPDATA%\Ogma`, the folder it used before the rename, and points saved paths at the new folder. App-specific environment variables use the `VERDANDI_` prefix.

## Checks

```powershell
cd app; npm run lint; npm run typecheck; npm test; npm run build
cd sidecar; .\.venv\Scripts\python.exe -m pytest -q
```

## How the app and sidecar connect

- The app spawns `sidecar/.venv` Python on a free `127.0.0.1` port with a random per-launch bearer token (passed by environment variable, never on the command line).
- Every sidecar route requires the token. The renderer never talks to the sidecar directly; it goes through the main process over IPC.
- The sidecar is given the app's process id and exits when the app does, so it cannot outlive the app, even after a crash.
- If the sidecar dies or fails three health checks, the app restarts it with backoff, up to three attempts, then shows the error and logs.
- `VERDANDI_PYTHON` and `VERDANDI_SIDECAR_DIR` override the Python and sidecar locations.

## License

[GPL-3.0-or-later](LICENSE), for both the app and the sidecar. Forks and modified versions
you distribute must also be released under the GPL. An [additional permission](LICENSE-EXCEPTION)
allows distribution through app stores such as Apple's, as long as the source stays freely
available elsewhere. Contributions are accepted under the same terms. The Wiktionary data the app downloads
keeps its own terms (CC BY-SA and GFDL).
