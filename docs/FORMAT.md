# Verdandi's document format

A Verdandi document is plain Markdown: one file holds the text, and each other layer (notes, an outline, research, images) has a file of its own. **Sections are headings**, written the same way in every file. Nothing in the files is hidden or specific to Verdandi except a few lines of frontmatter, so every file reads on its own in Obsidian or any editor.

> **Status:** Verdandi reads and writes this format (Phase 9, PLAN.md §3c) for a document folder: a folder holding a main file named after it. A main file on its own, outside such a folder, isn't recognised yet.

## At a glance

```
Salt and Signal/
  Salt and Signal.md            ← the main file: frontmatter, then the text
  Salt and Signal - Notes.md    ← the notes layer
  Salt and Signal - Outline.md  ← the outline layer
  attachments/lighthouse.svg    ← images the document uses
```

`Salt and Signal.md`:

```markdown
---
verdandi: document
layers:
  - {name: notes, kind: prose}
  - {name: outline, kind: list}
---
# Salt and Signal

## The Last Lamp

The lamp at Skerrow had been lit every night for ninety-one years…

## Paraffin and Prayer

Tobias Vale had not prayed since his wife died…
```

`Salt and Signal - Notes.md`:

```markdown
## The Last Lamp

Open on the lamp, not on Maren. Let the reader meet the light first.

## Paraffin and Prayer

Too on the nose? Maybe he says nothing and we only see him polish longer than he needs to.
```

`Salt and Signal - Outline.md`:

```markdown
## The Last Lamp

- The lamp's routine, through Maren's hands
- The letter: the light is to be automated
```

That is the whole format. The rest of this page is the detail.

## The main file

The main file is the document: it is what shows in Verdandi's sidebar and what you open. Its body is the text, the manuscript itself. Its frontmatter says it is a Verdandi document and describes the rest.

### Frontmatter

| Key | Required | What it does |
|---|---|---|
| `verdandi: document` | yes | Marks the file as a Verdandi document. |
| `section-level` | no, default `2` | The heading level that starts a section: `2` for `##`, `1` for `#`. |
| `layers` | no | The other layers, in the order they are offered. Leave it out for a document that is text only. |
| `sections` | no | Fields for sections, keyed by heading. Leave it out if no section has any. |

Any other frontmatter keys you already use (tags, aliases, dates) are kept as they are.

### Sections

- **A heading at the section level starts a section**, and the heading's text is the section's name. With the default `section-level: 2`, every `## Heading` is a section.
- **Deeper headings stay inside their section.** A `###` inside a chapter is part of that chapter's text, not a section of its own.
- **A `#` heading above the first section is the title** of the document. Without one, the title is the file name.
- **Text before the first section** belongs to the document as a whole: an epigraph, a foreword, a dedication.
- **Names must be unique** within a document, because they are how the files are matched. Two chapters both called "Interlude" need telling apart: "Interlude (1)" and "Interlude (2)", or "Interlude: Fog" and "Interlude: Static".
- **If your chapters are `#` headings**, either set `section-level: 1` (the title then comes from the file name), or change them to `##` and add a `#` title line.

### Layers

Each entry under `layers` declares one layer:

```yaml
layers:
  - {name: notes, kind: prose}
  - {name: outline, kind: list}
  - {name: research, kind: prose, file: Research for Salt and Signal.md}
  - {name: images, kind: gallery}
```

- **`name`**: what the layer is called. Lower-case words work best; Verdandi shows them capitalised ("Notes") Spaces and other characters are fine (`draft 11-21`): the name shows as written, and inside the working text it becomes `draft-11-21`.
- **`kind`**: how the layer is edited and shown.
  - `prose`: ordinary Markdown.
  - `list`: a Markdown list under each section, shown as an outline. Dragging sections in the outline view reorders the document.
  - `gallery`: images, shown as a grid.
- **`file`** (optional): the layer's file name. The default is `<main file name> - <Layer>.md`, for example `Salt and Signal - Notes.md`. Names that include the document's name stay unique across a vault, so Obsidian links never point at the wrong file.

**Undeclared layer files are read too.** A file in the folder named `<main file name> - <Name>.md` that no declared layer reads opens as a prose layer called `<Name>`. Saving the text doesn't add it to `layers`; changing the document's layers (in the Layers dialog) declares it.

The text itself is not declared: it is always the main file's body.

### Fields

Fields describe sections: status, point of view, tags, anything you filter or sort by. Verdandi's saved views filter on them (`status: draft`, `tags: act-1`).

```yaml
sections:
  The Last Lamp: {status: revised, pov: Maren, tags: [act-1, island]}
  Static: {status: draft, pov: Ilse}
  Fog lifts: {heading: false}
```

- **Keys are section names**, written exactly as the heading. Quote a name that contains a colon: `"Coda: Harlow Point": {status: draft}`.
- **Values** are whatever YAML allows: text, numbers, lists.
- **`heading: false`** is the one field Verdandi reads itself. That section's heading is left out of exports, so its text runs on from the section before. Use it for a scene inside a chapter: it is a section you can move, annotate and filter in Verdandi, while the exported manuscript reads as one continuous chapter. The heading stays in the main file either way.

## Layer files

A layer file holds one layer for every section, under the same headings as the main file:

```markdown
Notes on the whole book: the island is never named on the mainland.

## The Last Lamp

Open on the lamp, not on Maren.

## Static

Ilse's chapters are short.
```

- **The same heading level** starts sections, with the same names as in the main file.
- **Deeper headings** inside a section are part of that layer's content.
- **Text before the first heading** is that layer for the document as a whole (a synopsis, sources, a cast list).
- **Leave out sections with nothing in this layer.** Verdandi still shows the layer for every section, and writes a heading only when a section has content.
- **Order doesn't have to match** when you write the file. The main file decides the order, and Verdandi puts the layer files in the same order the next time it saves them.
- **No frontmatter is needed.** If the file has some, it is kept.

What goes under a heading depends on the layer's kind:

- **prose**: any Markdown.
- **list**: a Markdown list. Nested items are fine.

  ```markdown
  ## The Last Lamp

  - The lamp's routine
    - through Maren's hands
  - The letter arrives
  ```

- **gallery**: one image per line, as an Obsidian embed with an optional caption after `|`, or as a Markdown image. Other lines (a note about the images) are kept.

  ```markdown
  ## The Last Lamp

  ![[skerrow-map.svg|Skerrow and the sound]]
  ![[lighthouse.svg|The tower]]
  ```

  Image files go in the document's `attachments/` folder, or anywhere Obsidian would find them.

## Saved views

Saved views are kept in `.verdandi/views.yaml` beside the main file. You don't need to write any: Verdandi creates the file when you save a view. Obsidian doesn't show dot-folders.

## Converting files you already have

### One Markdown file with chapters as headings

1. Add frontmatter at the top:

   ```markdown
   ---
   verdandi: document
   ---
   ```

2. If the chapters are `#` headings, add `section-level: 1` (or change them to `##` and add a `# Title` line above the first).
3. Make sure no two chapters have the same heading.

That's a complete document. Add layers whenever you like.

### A manuscript plus a separate notes file

1. Convert the manuscript as above, and add the layer:

   ```yaml
   layers:
     - {name: notes, kind: prose}
   ```

2. Rename the notes file to `<Manuscript> - Notes.md`, or keep its name and add `file: <its name>.md` to the layer.
3. In the notes file, put each chapter's notes under a heading with exactly that chapter's name, at the same level. Notes that aren't about one chapter go above the first heading.

### A folder of chapter files

Join the chapters into one main file, each under a `##` heading named after the chapter. The chapter files' frontmatter becomes the fields under `sections`, and any notes or outline kept in them go into layer files.

A PowerShell sketch that joins every `.md` file in a folder, in name order, into a main file. It assumes each chapter file has no frontmatter:

```powershell
$folder = 'D:\writing\Salt and Signal chapters'
$title  = 'Salt and Signal'
$out    = Join-Path $folder "$title.md"
$parts  = @("---", "verdandi: document", "---", "# $title", "")
Get-ChildItem $folder -Filter *.md | Where-Object { $_.FullName -ne $out } | Sort-Object Name | ForEach-Object {
  $parts += "## $($_.BaseName)", "", (Get-Content $_.FullName -Raw).TrimEnd(), ""
}
# UTF-8 without a byte-order mark, so the frontmatter is the very first thing in the file.
[IO.File]::WriteAllText($out, ($parts -join "`n"), (New-Object Text.UTF8Encoding $false))
```

Chapter files whose names start with numbers for ordering ("01 The Last Lamp") will keep the numbers in their headings; rename the headings afterwards, or strip the numbers in the script.

### Notes written inline in the text

Verdandi's notes belong to a section, not to a paragraph, so inline notes (comments in brackets, `%% … %%`, callouts) move to the notes file under their section's heading, in the order they came. To keep track of what a note referred to, quote a few words of the paragraph at the start of the note.

### Documents from an earlier Verdandi

Folder documents (a document note with a file per section) convert by themselves when Verdandi opens them. The earlier files are kept in `.verdandi/converted/` inside the folder. One-file documents with `::: notes` blocks become document folders when opened, with Undo. There is no need to convert either by hand.

## Checklist

- [ ] The main file starts with frontmatter containing `verdandi: document`.
- [ ] `section-level` matches the level your sections use (default `2`, `##`).
- [ ] Every section heading in the main file is unique.
- [ ] Each layer is declared under `layers` with a `kind`, and its file is named `<main file> - <Layer>.md` or given with `file:`.
- [ ] In every layer file, headings match the main file's exactly, at the same level.
- [ ] Fields are under `sections`, keyed by the exact heading; names with a colon are quoted.
- [ ] Images are in `attachments/` (or anywhere Obsidian finds them) and embedded with `![[name.ext]]`.

## What Verdandi does with files edited elsewhere

You can keep editing these files in Obsidian or any editor. When Verdandi finds something that doesn't line up, it keeps it and shows it, rather than guessing silently:

- **A heading in a layer file that matches no section** shows in that layer as a stray section, with options to attach it to a section (renaming the heading) or make it a new section.
- **A section renamed in only one file**, the main file or a layer, is paired with its old name automatically when it is the only change of its kind, and the other files are renamed to match on the next save.
- **A heading deleted from a layer file** joins what was under it to the section above, as the Markdown reads. History can put it back.
- **Fields for a name that no longer has a heading** are kept and listed in that document's Fields… dialog, to attach or drop.
