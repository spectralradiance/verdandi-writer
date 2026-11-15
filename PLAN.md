# Verdandi Writer — Project Plan

Verdandi Writer is a writing workspace with three parts: a Markdown editor that renders as you type (like Typora), documents that are one Markdown file each, split into sections by their `#` headings, with each section's **notes** kept inline beside its **output** (the text itself), and lexical and AI tools that work on the text you have selected.

It is one of the three Norn apps (see *The Norn Apps: Feature Boundaries*, Nov 12, 2026). **Verdandi is where you write.** Urdr Reader is where you read, and Skuldr Social is where you publish and talk with people. Verdandi receives material from Urdr and sends finished work to Skuldr; it doesn't copy either. It started on Windows desktop and grows to macOS, Linux, web and mobile (Phase 7).

| Verdandi owns | Others |
|---|---|
| Writing, notes, drafts, version history | Urdr sends highlights and quotes in; nothing else edits |
| Dictionary and vocabulary (Wiktionary) | Urdr has a quick definition lookup only |
| AI drafting, analysis, chat and agent | None |
| Git sync of documents | None |
| | **Urdr:** all reading, including research reading. No browser or feed panel here |
| | **Skuldr:** posting and the personal site. Verdandi never posts directly |

---

## 1. What we can reuse

| Source | What it has | How Verdandi uses it |
|---|---|---|
| **Prototype `frontend/`** (React 19, TS, Vite, CodeMirror 6) | `editor/liveMarkdown.ts` (live render built on regexes, one line at a time), `MarkdownEditor.tsx`, `dictionaryHover.ts`, `DictionaryInspector.tsx`, `WorkspaceEditor.tsx` (file tree, Ctrl+S, atomic saves) | Starting point for the editor. We rebuild the live renderer on the Lezer syntax tree (see Phase 1). Hover and inspector patterns carry over. |
| **Prototype `frontend/src/lib/dictionary`** + `scripts/setup-wiktionary.ts` | Kaikki Wiktionary to SQLite with FTS5. Its `data/wiktionary.db` (~900 MB) is **already built** and stores senses, examples, IPA, **etymology, synonyms, antonyms, derived and related terms** | Copy the module as is. It covers the offline dictionary, etymology and most of the thesaurus with no network calls. |
| **Prototype `code/write_book.py`** + **`api/jobs.py`** | 4-bit Qwen loading with transformers and bitsandbytes, CUDA guardrails, a serialized GPU job queue with cancellation and SSE | The **local model provider** and job queue in the sidecar. |
| **aisling** (Electron, Vue 2) | Personal lexicon model `{word, definition, tags, synonyms}`, prefix search (`tag:`, `synonym:`), and a list of external lookup URLs (etymonline, rhymezone, M-W…) | Data model and UX ideas for the Lexicon, plus an importer for `Vocabulary/*.json`. The code is too old to reuse directly (Electron 1.7, Vue 2). |
| **oisin-old/pipeline** (Python) | Chunking, local embeddings (bge-small), taxonomy from folder structure, Claude synthesis prompts | Prompt and design reference for synthesis. Embeddings are used for related-notes search later. |
| **Existing notes trees** (e.g. the prototype's `data/input/outlines_notes/`) | Already laid out as "folder = document, numbered file = section" (`1 universal narrative/1 the first era`), and many files are extensionless or `.txt` | Added to the workspace **as they are** and edited in place (§3). They are the main test material. |

---

## 2. Architecture

```
Renderer (React + TS + Vite)
 ├─ Sidebar: workspace roots → folders → documents; Outline: the open document's sections
 ├─ Editor: rows of CodeMirror 6 editors, two per section (text and notes)
 └─ Right drawer: Dictionary / Etymology / Thesaurus / Lexicon / AI
        ▲  typed IPC (contextBridge)
Electron main process (Node)
 ├─ Workspace service   — multiple root folders, section discovery, file watching, in-place atomic saves
 ├─ Dictionary service  — better-sqlite3 over wiktionary.db (reused from the prototype)
 ├─ Lexicon service     — saved words
 ├─ Secrets             — API keys in the OS keychain (safeStorage), passed to the sidecar at launch
 └─ Sidecar manager     — starts and stops the Python process, checks its health, restarts it if it crashes
        ▲  HTTP + SSE on 127.0.0.1:<random port>, per-session bearer token
Python AI sidecar (FastAPI + uvicorn, own venv)
 ├─ Router              — picks a model profile for each task, with fallback (§2a)
 ├─ Provider layer      — one interface; the rest of the app never imports a vendor SDK
 │   ├─ local_hf        — transformers + bitsandbytes on CUDA (4-bit Qwen), the prototype's approach
 │   ├─ anthropic       — Claude
 │   ├─ openai          — ChatGPT / OpenAI models
 │   ├─ gemini          — Google Gemini (google-genai SDK)
 │   └─ openai_compat   — any OpenAI-compatible endpoint (base URL + key): OpenRouter,
 │                        privacy-focused open-model hosts, or a local server later
 ├─ Embeddings          — sentence-transformers (bge-small) for related-notes search
 ├─ GPU job queue       — one GPU job at a time, cancellable, streamed over SSE (from the prototype)
 └─ Prompt templates    — editable Markdown files, independent of the provider (§3)
```

**Why Electron with a Python sidecar:**
- The app edits folders on disk in place, so it needs real filesystem access and file watching. Electron provides both.
- `better-sqlite3` and the existing dictionary code run in Node without changes.
- The prototype's React and CodeMirror code moves straight into the renderer.
- CUDA, quantization and embeddings belong in Python, where the prototype already has working code.
- The editor never depends on the sidecar. Editing, dictionary and lexicon work even when Python isn't running, and only the AI panel shows "offline".
- All AI calls go through the sidecar, whichever provider serves them. That puts prompts, routing and history logging in one place, and the renderer uses a single streaming interface.

**Why CodeMirror 6 and not ProseMirror, Milkdown or TipTap:**
- The file on disk stays the source of truth, with no round-trip formatting loss. This matters more now that we edit your original files in place.
- The hover and lexical extensions already exist for it.
- Typora-style rendering is done with decorations that hide Markdown syntax except where the cursor is.

### 2a. Provider abstraction

Features never call a vendor directly. They call `run(task, messages)`, and the router resolves the task to a **model profile** and then to a provider adapter.

```python
class Provider(Protocol):
    id: str                                   # "anthropic", "openai", "gemini", "openai_compat", "local_hf"
    def models(self) -> list[ModelInfo]: ...  # id, context window, cost hints, capabilities
    def health(self) -> ProviderHealth: ...   # key present, reachable, CUDA ok, …
    def stream(self, req: GenerateRequest) -> Iterator[StreamEvent]: ...
```

- **One request shape:** `GenerateRequest` holds the system prompt, messages, max tokens, temperature and stop sequences. Each adapter translates it to its vendor's format. For example, Claude takes the system prompt as a separate field, OpenAI takes it as a message with the `system` role, and Gemini takes it as `system_instruction`.
- **One event shape:** every stream produces `text_delta`, `usage` (input and output tokens), `done` (stop reason) and `error`.
- **One error set:** vendor errors map to `auth`, `rate_limit`, `context_too_long`, `unavailable` and `bad_request`. The router uses these to decide whether to fall back, so features never see vendor-specific errors.
- **Adapters use the official SDKs**: `anthropic`, `openai` and `google-genai`, plus the `openai` SDK pointed at a custom `base_url` for `openai_compat`. The alternative is LiteLLM, which covers more vendors with one dependency but is a thick, fast-moving layer. The interface above keeps it possible to switch to LiteLLM later without touching features.
- **`openai_compat`** is how privacy-focused hosted open models plug in: OpenRouter, Together, Fireworks, or any host with an OpenAI-style API. A local LM Studio or Ollama server could be added later the same way, with no new code.
- **Model profiles** live in settings. A profile is a named `{provider, model, params}`, for example:
  ```json
  "profiles": {
    "claude-main":   { "provider": "anthropic", "model": "claude-sonnet-5", "max_tokens": 4096 },
    "gpt-alt":       { "provider": "openai",    "model": "<model id>" },
    "gemini-alt":    { "provider": "gemini",    "model": "<model id>" },
    "open-private":  { "provider": "openai_compat", "base_url": "https://…", "model": "<open model>" },
    "qwen-local":    { "provider": "local_hf",  "model": "Qwen/Qwen2.5-7B-Instruct", "quant": "4bit" }
  },
  "routing": {
    "synthesize": ["claude-main", "gemini-alt", "qwen-local"],
    "analyze":    ["qwen-local", "claude-main"],
    "lexical":    ["qwen-local", "claude-main"]
  }
  ```
- **Modes:** *Local* only allows `local_hf` profiles. *Cloud* only allows remote profiles. *Hybrid* (the default) follows the routing table. The AI panel can override the profile for a single request, and it shows when a fallback was used.
- **Keys:** each provider's API key is stored in the OS keychain (safeStorage) and passed to the sidecar as an environment variable at launch. Keys are never written to settings files.
- **Provenance:** every run records the profile, provider, model, token usage and a hash of the input.
- **Contract tests:** one shared test suite runs against every adapter, using recorded fixtures offline, plus an optional live smoke test when a key is set.

---

## 3. Workspace and on-disk format

**A workspace is a set of external folders edited in place. Nothing is copied.**

```
Workspace file  (e.g. Documents/Verdandi Writer/writing.verdandi-workspace — like a VS Code .code-workspace)
{
  "roots": [
    "D:/writing/outlines_notes",
    "D:/writing/poetry"
  ],
  "lexicon": "C:/Users/snowb/Documents/Verdandi Writer/lexicon",
  "promptsDir": "C:/Users/snowb/Documents/Verdandi Writer/prompts"
}
```

**Documents** (changed 2026-10-11; the earlier folder-of-sections format, with a `-notes` and an `-output` file per section, was removed):
- A **document is one Markdown file**. Folders are just folders, shown in the sidebar with their subfolders and documents.
- Text files are `.md`, `.markdown`, `.txt`, `.text`, and files with no extension, the same rules as the prototype's indexer.
- Each `#` heading starts a **section**; `##` and deeper stay inside it. A file with no `#` heading splits at its shallowest heading level. A `<!-- section: Name -->` line starts a **named section** instead: a name without a heading, shown above the row and in the outline, left out of exports (added 2026-11-14). A heading right under the marker belongs to it. Each row's menu renames, moves, merges and deletes sections, switches a name between heading and name only, and starts a named section at a paragraph (Ctrl+Alt+S).
- A section's **notes** sit in Pandoc-style fenced blocks, `::: notes` … `:::`, usually under its text. Notes before the first heading are notes for the whole document (outline, sources). Headings inside notes never start a section.
- The file is shown as rows, one per section, each with a primary and a secondary side (changed 2026-11-14; before, one editor showed Output, Notes or Both). The **Text view** puts the text first and the notes beside it, the **Notes view** the other way round. Two columns when wide, stacked when narrow. A row is as tall as its primary text unless dragged; the secondary side can be hidden per section or for the whole document. Each side is a small editor over a projection of its section, and edits are mapped back so notes blocks keep their place in the file.

**Editing in place safely:**
- Atomic saves: write to a temp file in the same folder, then rename.
- **Preserve encoding and line endings.** Old `.txt` notes may be cp1252 or UTF-8 with a BOM, and may use CRLF. The file is detected on open and written back in the same format.
- The file watcher detects edits made outside Verdandi (VS Code, sync tools). A clean buffer reloads silently. A buffer with unsaved changes shows a merge or keep-mine prompt.
- **Backup on first write:** the first time a file is modified in a session, its original is copied to `<appData>/Verdandi Writer/backups/<date>/…`. Backups are pruned after N days.
- Delete moves files to the OS trash, never deletes them permanently.

**App-owned data stays out of your folders by default.** It lives in `<appData>/Verdandi Writer/`:
- Per-document metadata (manual order overrides, collapsed state, custom section titles), keyed by path.
- AI run history.
- A "store metadata in folder" option per root writes a `.verdandi/` folder into that root instead, for roots you sync between machines.

The lexicon and prompt templates live in the folders named in the workspace file, as Markdown files with front-matter, so they can be read and edited outside the app.

---

## 3b. Sections and layers (planned 2026-11-14, Phase 8)

When Phase 8 is built, it replaces the one-file document format in §3. A document becomes a collection of sections, more like a CMS. Each section holds **layers**: its text, notes, outline, images, and any other layers the document defines. The files stay plain Markdown that Obsidian can open and edit; a workspace root can be an Obsidian vault.

**Shape:** a vault (workspace root) → a document (a folder) → a section (one `.md` file) → layers (parts of that file).

```
Eras/
  Eras.md                ← the document note: the layers and the order of the sections
  The First Era.md
  The Second Era.md
  attachments/map.png
  .verdandi/views.yaml   ← saved views (Obsidian hides dot-folders)
```

**The document note** declares the document's layers and lists its sections as embeds, in order. Opening it in Obsidian reads the whole document straight through, and reordering sections moves one line rather than renaming files.

```markdown
---
verdandi: document
layers:
  - {name: notes, kind: prose, anchored: true}
  - {name: outline, kind: list}
  - {name: images, kind: gallery}
---
![[The First Era]]
![[The Second Era]]
```

**A section file** is named after the section, which is Obsidian's convention for titles. Its frontmatter holds the section's fields and a stable `id`. Its body is the text layer, and the other layers are callouts:

```markdown
---
id: 7f3a
status: draft
tags: [act-1]
---
The text of the section…

> [!notes]
> A note on the paragraph above.

More text.

> [!outline]-
> - first beat
> - second beat
```

- **Anchored layers** (`anchored: true`, such as notes) sit right after the paragraph they belong to, as notes blocks do today. Other layers go at the end of the file. The `-` after a callout type makes it collapsed in Obsidian.
- **Frontmatter fields** (status, tags, POV and so on) are what saved views filter on. Obsidian's Bases can show the same sections as a table.
- **The `id`** lets Verdandi find a section again if its embed link goes stale. Obsidian updates embeds when a file is renamed inside it.
- **The exact title** goes in frontmatter when it can't be a filename, for example when it contains `:` `?` or `/`. The filename is cleaned up, and two sections with the same name get "Name 2".
- **Images** go in the document's `attachments/` folder and are embedded with `![[map.png]]`.

**Layer types belong to the document, so every section has the same layers.**
- **Kinds:** each layer has a kind — prose, list or gallery — which decides how it is edited and shown.
- **Empty layers aren't written:** a section with no outline has no outline callout, but the app still shows the layer.
- **Adding** a layer gives every section an empty one.
- **Renaming** a layer rewrites that callout in every section file.
- **Deleting** a layer that still has content asks first and takes a History snapshot.
- **Only declared layers count:** a callout is a layer only when its type is declared, so ordinary Obsidian callouts like `[!warning]` stay plain text. If a callout with a new type turns up, for example added in Obsidian, Verdandi leaves it as text and offers to add it as a layer.

**Splitting and merging:**
- **Split:** the layer you split from moves into the new section, and every other layer stays with the original. The new section starts with those layers blank. A split can start from any layer: making a section from notes selected in the notes view gives the new section those notes and blank text.
- **Anchored layers travel with their paragraph:** notes tied to a paragraph inside the selection move with it.
- **Text after the selection** continues as "Name (continued)", as it does now, also with blank layers. Nothing is copied, so nothing drifts apart.
- **Merge** is the inverse of split: each layer is joined onto the matching layer of the section above, and a heading becomes a subheading.
- **Move to section…** (later) moves one outline item, image or note to another section, for whatever a split leaves in the wrong place.
- **History:** a split or merge touches several files, so every file involved is snapshotted first, as delete does today.

**Views:**
- **A layer across the whole document:**
  - Notes read like today's notes-primary view.
  - Images show as a gallery grouped by section.
  - The outline is one combined outline, where dragging a section reorders the document.
- **One section:** all its layers on one page, as panels.
- **Controls:** collapse or hide sections, show or hide layers, choose the primary layer, and lay layers out side by side or stacked.
- **Saved views** are named and stored in `.verdandi/views.yaml`, so they travel with the document. A view records:
  - a scope: the whole document, one section, or a filter on fields such as `tags: act-1` or `status: draft`
  - which sections are shown, collapsed or hidden
  - which layers show, their order, the primary layer and the layout
- **Local view state** (scroll position, what is collapsed right now) stays in the app's preferences, not the vault.

**Converting single-file documents:**
- **Which files convert:** a file opened from the sidebar converts as soon as it opens if it already looks like a Verdandi document, meaning it has `::: notes` blocks or `<!-- section: -->` markers.
- **Other Markdown files** open read-only with a "Make this a document" button, so opening an ordinary Obsidian note to read it never changes it.
- **How a file is split:**
  - Each heading that starts a section today, and each section marker, becomes a section file.
  - Text before the first heading becomes "Introduction".
  - `::: notes` blocks become `> [!notes]` callouts, so the document starts with one declared layer, notes.
- **The original file** is kept in the new folder's `.verdandi/`, and a notice offers to undo the conversion.
- **Exports** still compile the whole document into one file, in the order the document note gives.

**Risk:** Obsidian, or a sync tool, editing section files while Verdandi has them open. One file per section keeps a conflict to one section, but the watcher and merge prompt (§3) have to work across a document's folder from the start.

---

## 3a. Repository layout (this `verdandi-writer/` folder)

```
verdandi-writer/
  app/                  # Electron + React + TS (electron-vite)
    src/main/           # workspace, dictionary, lexicon, sidecar manager, IPC
    src/preload/
    src/renderer/       # React UI, CodeMirror extensions
  sidecar/              # Python FastAPI AI server
    verdandi_ai/
      main.py           # routes: /health, /providers, /ai/run (SSE), /jobs, /embed
      router.py         # task → profile → provider, mode filtering, fallback
      types.py          # GenerateRequest, StreamEvent, ProviderError kinds
      providers/        # base.py, local_hf.py, anthropic.py, openai.py, gemini.py, openai_compat.py
      jobs.py           # GPU queue (from the prototype)
    tests/
    requirements.txt
  scripts/              # dev.ps1 (launch both), setup-sidecar.ps1 (venv + CUDA torch)
  PLAN.md
```

---

## 4. Build phases

### Phase 0 — Scaffold (1 day) ✅ done 2026-09-25
- `app/`: electron-vite with React and TS, ESLint and Vitest. Typed IPC bridge.
- `sidecar/`: FastAPI skeleton with `/health` reporting CUDA availability, VRAM, loaded models, and which provider keys are configured. Pytest.
- The sidecar manager spawns the venv Python on a free port with a random token, waits for `/health`, and kills the process tree on quit.
- `scripts/dev.ps1` runs both pieces for development.
- **Done when:** the app launches and the status bar shows the sidecar and GPU status.

### Phase 1 — Live Markdown editor (the core, ~1 week) ✅ done 2026-09-25
Also landed early from Phase 2 because in-place editing needed them: a lazy file tree per root, atomic saves, conflict detection (mtime), and backup-on-first-write. The folder watcher and section model remain Phase 2.

- Port `MarkdownEditor.tsx` and rewrite `liveMarkdown.ts` to walk the **Lezer syntax tree** instead of using regexes:
  - Headings, bold, italic, strike, inline code, links (show the text and hide the URL), images (render inline), blockquotes, lists and task checkboxes, horizontal rules, fenced code (with highlighting), tables (render as a widget, show the source when the cursor is inside).
  - Syntax is revealed only for the **node** under the cursor, not the whole line, which is how Typora behaves.
- `.txt` and extensionless files open in the same editor. Markdown rendering applies wherever the text happens to be Markdown.
- Typography theme (serif body, comfortable line length), light and dark modes, focus mode.
- Ctrl+S, autosave with a debounce, an unsaved-changes indicator, and encoding and line-ending preservation.
- **Done when:** any file from your notes opens, edits and saves back byte-identical except for your changes, and looks rendered everywhere except where the cursor is.

### Phase 2 — Workspace, documents & sections (~1 week) ✅ done 2026-09-25
What shipped differs from the spec below in four places:
- Roots live in the app's settings; the separate `.verdandi-workspace` file (several named workspaces) is deferred until it is needed.
- Reordering is ↑/↓ (swapping ordinals, both files renamed together) rather than drag and drop.
- Scroll sync between panes is deferred.
- The watcher uses Node's recursive `fs.watch`; on folders it cannot watch (possibly some cloud-drive mounts) the tree only refreshes when a folder is reopened, but edits still never overwrite outside changes, because every save checks the file's mtime.

- Workspace file: create or open it, and add or remove roots (folder picker). The last workspace reopens on launch.
- Section discovery as in §3, with a watcher on every root. Create, rename, reorder and delete sections. Renaming renames the notes and output files together. Reordering changes the number prefix, or only the metadata if you prefer that.
- Sidebar: roots → documents (nested) → a Document notes group + ordered sections, plus headings inside each file as sub-entries.
- **Dual pane:** notes on the left and output on the right, with a resizable splitter. Each pane can collapse, and the two panes can switch places. Optional scroll sync matched by heading.
- Backups on first write, and external-change handling.
- **Done when:** you add `outlines_notes` as a root and work through `universal metaphysics` section by section, with your original files edited in place.

### Phase 2b — Whole-document views ✅ done 2026-09-25
A double document (folder of sections) opens whole, in four views: **Column** (each section's output, then its notes as a background block), **Side by side** (aligned rows), **Output** only and **Notes** only. Single files open as regular documents.

### Phase 2c — One file per document ✅ done 2026-10-11
Replaced the folder-of-sections format (Phases 2 and 2b) with the one-file format in §3: sections from `#` headings, inline notes blocks, and Output / Notes / Both views of one editor. The section files, section operations (rename, move, merge, delete) and the per-section view are gone; the sidebar lists plain folders and documents, with rename and undoable delete for files. Stats, export, search and AI drafting work on the single file.

### Phase 3 — Lexical tools (~1 week, mostly reuse) ✅ done 2026-09-25
Uses Node's built-in `node:sqlite` (no native module) over the prototype's `wiktionary.db`, with indexed case-variant lookups (the original `COLLATE NOCASE` query scanned all 1.5M rows, ~10 s). Not done: underlining lexicon words in the text.

- Copy the prototype's dictionary module and point it at `wiktionary.db`. The path is configurable, and the setup script can rebuild the database if it is missing.
- Right-hand drawer with tabs that follow the current selection or the word under the cursor:
  - **Define:** senses, examples, IPA and part of speech.
  - **Etymology:** the etymology text, with root words you can click to look up.
  - **Thesaurus:** synonyms, antonyms, related and derived terms. Clicking a term looks it up, and Alt+click replaces your selection with it.
  - **External:** Aisling's lookup-URL table (etymonline, rhymezone, M-W) opened in the system browser. Not in an in-app panel: Verdandi has no built-in browser.
- Hover definition (from the prototype's `dictionaryHover.ts`) and a Ctrl+D shortcut to open the drawer.
- **Lexicon:** a "Save word" action stores the word, definition, tags, your own note, and the sentence and section it came from. There is a lexicon browser with Aisling-style prefix search (`tag:`, `syn:`), and an importer for Aisling's `Vocabulary/*.json`.
- Optional: underline words in the text that are already in your lexicon.

### Phase 4 — AI tools (~2 weeks) ✅ done 2026-09-25
Tested end to end against a local mock of an OpenAI-compatible server (no API keys were available); the Claude, OpenAI and Gemini adapters are contract-tested through their real SDKs against mocks of each wire format. Not yet exercised: live cloud calls and the local GPU model (needs `setup-sidecar.ps1` without `-NoTorch` and a model download). Draft output uses the section's notes, current output and document notes; neighbouring sections are not yet included.
- **4a. Provider layer (sidecar):**
  - The `Provider` protocol, the shared request and event types, and error normalization (§2a).
  - `local_hf` ported from the prototype: 4-bit Qwen that loads lazily, frees VRAM after an idle timeout, and keeps the CUDA guardrails.
  - `anthropic` first. Then `openai`, `gemini` and `openai_compat`, each about a day, since they only translate to and from the shared types.
  - A router with profiles, the routing table, mode filtering and fallback on `unavailable`, `rate_limit` or `auth`. SSE streaming to the app.
  - A contract test suite run against every adapter, plus a fake provider for feature tests.
- **4b. AI panel and settings (app):**
  - A mode switch (Local / Cloud / Hybrid) and a per-request profile picker.
  - A streaming output view with cancel, and a provenance note on each result.
  - A settings page for API keys (keychain), model profiles and the routing table, with a "test connection" button for each provider.
- **Analyze** (current selection or section): tone, structure, readability (the numeric scores such as Flesch and sentence-length spread are computed locally, and the AI adds the qualitative read), and style notes. Results appear in the drawer, not in your text.
- **Synthesize notes → output:** reads the notes file (plus, optionally, the document notes such as `outline`, the output of the neighbouring sections, and a style guide) and puts a draft into a **diff/merge view** against the output file. You accept or reject each hunk, so the AI never overwrites your text silently.
- **Lexical assist:** "vary this word", "stronger verb", and "thematic vocabulary for this section". Suggestions come back as a list, and each option is checked against the local dictionary.
- Prompt templates are editable `.md` files (the same idea as the prototype's `guidance.json`), and each run is logged to the history.

### Phase 5 — Polish & later ✅ done 2026-09-25 (except embeddings)
Shipped: search across all roots (SQLite FTS5 index, Ctrl+Shift+F), keyword-based "related notes", export to PDF/HTML/Markdown, per-file version history (automatic every 10 minutes while editing, plus labelled snapshots, diff and restore), and writing statistics (per-section counts, output goal, net words per day). Not done: DOCX export, embedding-based related notes (needs the PyTorch stack), git-backed history (now part of Git sync, Phase 7).
- Global search across all roots (ripgrep or SQLite FTS).
- Export a whole document as the output files joined into one `.md`, HTML, PDF or DOCX.
- Version snapshots for each section (git per root, or the backup store).
- "Related notes" for the current section using embeddings across all roots (oisin-old and prototype retrieval).
- Word-count goals and writing statistics for each section.

**Deferred (not planned for now):**
- LM Studio / Bionic integration. Its models could be used through `openai_compat` with no new code. A Verdandi MCP server that lets Bionic or Claude work on the workspace (with edits as reviewable proposals) could be revisited later.

### Phase 6 — Norn handoffs
Each handoff is a one-way send by file, deep link or URL, never shared in-app state, so Verdandi still works installed alone.
- **Import from Urdr:** highlights, notes and quotes land in a section's notes block, each with a source link. Two ways in: a Markdown file Urdr exports (drop it on a section, or "Import highlights…"), and a `verdandi://import?…` deep link registered by the desktop app. The format is agreed with Urdr:
  ```markdown
  > The quoted text.

  — *Book or article title*, Author · [source](https://…) · chapter or section
  Your note, if any.
  ```
- **Word lookups from Urdr:** `verdandi://word/<word>` opens the Words panel on that word.
- **Publish to Skuldr:** a "Publish…" action sends the document's output (notes left out) to Skuldr as a page or story **draft**. You review and publish it in Skuldr, so identity and the site stay there. Waits until Skuldr's page record is stable. Skuldr's page format is structured rich text, so the conversion from Markdown lives in the shared lexicons package, not here.
- **Share a passage:** opens Skuldr's share URL with the selection prefilled.
- **Done when:** a highlight from Urdr ends up in the right section's notes with its source, and a finished document arrives in Skuldr as a draft page.

### Phase 7 — Platforms and Git sync
Desktop stays the full app; web and mobile are a lighter editor over the same files.
- **Shared editor package:** pull the React editor (CodeMirror extensions, document model, views, the Words panel UI) out of `app/src/renderer` into a package with no Electron imports. Desktop adds direct file access and the AI sidecar; web and mobile get the editor alone.
- **Git sync:** documents are already plain Markdown files, so a workspace root that is a Git repo (for example a private GitHub repo) syncs between devices. Desktop runs ordinary Git; web and mobile use isomorphic-git against the same remote. Commits double as the git-backed history from Phase 5. App-owned data in `<appData>` (metadata, AI history, snapshots) doesn't sync unless the root uses the "store metadata in folder" option.
- **Desktop:** extend from Windows to macOS and Linux. Replace Windows-only pieces: DPAPI wording for keys (safeStorage works on all three), `.ps1` scripts, and the CUDA-only local model (add Apple Silicon or CPU fallback, or leave local AI Windows/Linux-only).
- **Web:** the editor over Git sync, with cloud AI only.
- **Mobile (Capacitor):** reading and editing, search, the dictionary and Git sync, with cloud AI or your desktop's model. Keyboard shortcuts work with a plugged-in keyboard.
- **Dictionary on mobile and web:** the built `wiktionary.db` is about 1 GB, too big to bundle. Ship a common-words subset or look words up from a hosted copy.
- **Signing:** Windows code signing, macOS notarization, Apple and Google developer accounts.

### Phase 8 — Sections and layers
Builds the format in §3b. Unlike the folder-of-sections format removed in Phase 2c, which split each section into a notes file and an output file, each section is one file holding all of its layers.

**Progress (2026-11-14):**
- **Done:** the disk format in `shared/layers.ts`. It covers frontmatter edits that keep comments and field order, declared layers, callouts on disk ↔ `::: layer` blocks in the working text, section files, the document note, and the one-file → folder conversion with its file names.
- **Also done:** `main/folderDocument.ts` converts a file on disk and undoes the conversion.
- **Done, steps 2–3 (for the notes layer):** document folders open, save and show in the sidebar.
  - **How they're shown:** for now the editor shows a document folder as one text, its sections joined with markers that carry each file's id and heading setting (`<!-- section: Name {#7f3a .heading} -->`). Markers with ids make only markers start sections, so a heading in a section's text never splits it.
  - **Saving** matches sections to files by id and writes only the changed ones. It renames files whose section was renamed, makes files for new sections, trashes the files of removed ones, and rewrites the document note when the order or the names change. Any change to one of the document's files counts as a change to the document, which is how conflicts are found.
  - **What keeps working unchanged:** rows, section menus, the outline, search (a document folder is indexed as one document), stats, export (`.heading` names become `#` headings), History and AI.
  - **Conversion and read-only:** one-file documents with notes blocks or section markers convert on open, with Undo. Other notes open read-only with "Make this a document", and New document makes a document folder.
- **Done, step 4 (views), 2026-11-14:** any layer the document declares shows in the rows, and any layer can be first. The other layers sit beside it as a stack of panels, side by side or stacked. Layers are added, renamed, re-kinded and deleted from the header (rename and delete rewrite the callouts in every section file; delete asks first and snapshots History). Sections can be collapsed, hidden, filtered on their frontmatter fields, or opened on a page of their own. Named views are saved in `.verdandi/views.yaml` (`shared/views.ts`); the view in use is kept in preferences per document.
- **Done, step 5 (everything that reads documents), 2026-11-14:**
  - **Sections per layer:** `splitSections` gives each section's layers apart (`layers`, `layerWords`).
  - **Stats:** the Stats dialog counts words per layer.
  - **Export:** exports the text, any one layer, or every layer, each under a subheading. Obsidian's `![[image.png]]` embeds become images (found in `attachments/`) and `[[links]]` become their text. A document folder's images now resolve against the folder itself.
  - **AI:** Draft output gets every layer, each under its own heading. Analyze reads the finished text without section markers. The default prompts describe layers and markers.
  - **Search:** leaves `:::` lines and marker ids out of the index (version 1, so old indexes rebuild once) and reads a marker as its section's name, with line numbers unchanged.
  - **Callouts from Obsidian:** a callout whose type isn't declared, such as `> [!beats]`, gets a banner offering to make it a layer, or to keep it as text.
  - **Renamed files:** `.verdandi/sections.yaml` remembers which file each section id was in. When a section file is renamed outside Obsidian, its stale embed finds the file again by that id, or, with one stale embed and one unlisted file, they are matched to each other; the next save writes the new name into the note. The folder watcher already counted any change in a document folder as a change to the document.
  - **Fixed:** with a section marker removed, a section ending in a layer block no longer runs into the next section's first paragraph in exports.
- **Next:**
  - **Layer kinds:** a gallery layer that shows `![[image]]` embeds as a grid, with images added to `attachments/`, and a list layer whose outline across the document can be dragged to reorder sections. Today every kind is edited as Markdown.
  - **Split from any layer**, as §3b describes (today a split starts from the text), and fields edited in the app rather than only in Obsidian.
  - **The Urdr import** (Phase 6) is not built yet. When it is, highlights land in the section's notes layer as callout content, which `splitSections` already reads per layer.
  - **The status bar's "in notes" count** and the daily totals still take every layer other than the text together; the Stats dialog has them per layer.
- **What moves and what stays:** in the working text, a block's opening line keeps the callout's fold sign and title (`::: notes - Title`), so only hand-written quote marks (`>x`, leading spaces) are tidied when a section is saved. A file that is not changed is never rewritten.

1. **Model:**
   - Parse and write a section file: frontmatter, the text layer, anchored callouts and end callouts. Round-trip tests come first, against files edited by hand and in Obsidian.
   - Parse and write the document note: its layers and its embeds.
   - The projection model in `sectionModel.ts` carries over, with callouts in place of `::: notes` blocks.
2. **Conversion:**
   - Detect old-format files and convert them on open, keeping the original in `.verdandi/` with an undo.
   - Open other Markdown files read-only, with "Make this a document".
3. **Document operations across files:** add, rename, move, split, merge and delete sections, with every file involved snapshotted in History first. Also add, rename and delete layers.
4. **Views:**
   - The rows view generalised to any set of layers.
   - The layer-across-document views: notes, gallery and outline.
   - The one-section page.
   - Saved views in `.verdandi/views.yaml`, with field filters.
5. **Everything that reads documents:** search, stats, export, AI drafting (which reads a section's layers) and the Urdr import (which lands in the notes layer) move to the new format. So does the folder watcher.
- **Done when:** an old one-file document opens as a folder of sections that Obsidian reads straight through. A section split or merged in Verdandi, or edited in Obsidian, keeps every layer where it belongs. A saved view filtered on `status: draft` reopens as it was left.

---

## 5. Decisions

**Decided:**
- Electron plus a Python AI sidecar.
- AI runs through a provider abstraction: a local model (transformers/bitsandbytes, as in the prototype), plus Claude, OpenAI, Gemini and any OpenAI-compatible host. The modes are Local, Cloud and Hybrid.
- LM Studio / Bionic is deferred.
- A workspace is a set of external folders edited in place, with no copying.
- The code lives in this repo. The scope is the features listed here and nothing more.

- A document is one Markdown file: `#` headings make the sections and notes are inline (§3). This settles the earlier open questions about reordering sections and naming output files.

- Verdandi's place among the Norn apps (2026-11-13): it receives reading material from Urdr and sends finished work to Skuldr (Phase 6). It does **not** get a built-in browser or feed panel, even a small one, and it does **not** post directly. Packages, app IDs and folders use the name Verdandi (renamed 2026-11-14). The old `%APPDATA%\Ogma` profile moves to `%APPDATA%\Verdandi Writer` on first launch.

- Sections and layers (2026-11-14, Phase 8): a document becomes a folder of section files that Obsidian can open, and each section holds the layers the document declares (§3b). This replaces the one-file decision above once Phase 8 is built. A split moves only the layer it was made from (and the anchored notes inside it), and leaves the others with the original. Old one-file documents convert when opened; other Markdown files are never changed unless asked.

**Open questions:**
- **AI on web and mobile:** the sidecar is a local Python process. Without it, cloud calls need either your API keys stored on the device (web storage is weaker than the OS keychain) or a small hosted relay. "Your desktop's model" on a phone needs the desktop sidecar reachable over the network, which today binds to 127.0.0.1 only.
- **Publish transport:** does Verdandi call Skuldr's API (signing in to your Skuldr instance), or open Skuldr with the draft attached? Decided with Skuldr.
