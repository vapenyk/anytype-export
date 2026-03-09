---
title: "Configuration"
description: "All export flags, filtering options, and output settings."
---

# Configuration

All options are CLI flags. There is no config file. Credentials (API key, space ID, gateway URL) are saved by `anytype-export login` and loaded automatically — you never pass them manually.

## Global flags

| Flag | Alias | Description |
|---|---|---|
| `--help` | `-h` | Show all commands and flags |
| `--version` | `-v` | Print the current version |

## Output

| Flag              | Default      | Description |
|-------------------|--------------|-------------|
| `--output DIR`    | `./export`   | Directory to write exported markdown files. Created if it doesn't exist. |
| `-o DIR`          |              | Short alias for `--output`. |
| `--dry-run`       | `false`      | Print what would be exported without writing any files. |
| `--force`         | `false`      | Ignore cache, re-export every object. |
| `--group-by-type` | `false`      | Write files into subdirectories per type — `export/Note/slug.md`, `export/Task/slug.md`. |
| `--create-index`  | `false`      | Generate an `index.md` in the output root listing all exported objects grouped by type. |

```bash
anytype-export --output ~/vault --group-by-type --create-index
anytype-export -o ~/vault --group-by-type --create-index
```

## Filtering

| Flag                        | Default | Description |
|-----------------------------|---------|-------------|
| `--include-types Note,Task` | —       | Comma-separated type names to export. All other types are skipped. Case-insensitive. |
| `--exclude-types Template`  | —       | Comma-separated type names to skip. Applied client-side after fetching. |
| `--no-files`                | `false` | Skip downloading images and attachments. Markdown bodies are still exported. |

```bash
# Only notes and tasks
anytype-export --include-types Note,Task

# Everything except bookmarks and templates
anytype-export --exclude-types Bookmark,Template

# Text-only export, no attachments
anytype-export --no-files
```

Type names are matched against the display name in Anytype (e.g. `Note`, `Task`, `Human`, `Movie`). Run `--dry-run` first to see what types your space contains.

> **Performance note:** When `--include-types` is set, the type list is forwarded to the Anytype API as a query parameter for server-side pre-filtering. This reduces the number of objects fetched for large spaces. Client-side filtering is still applied as a fallback.

## Incremental exports

By default every run uses a cache file (`.anytype-cache.json` in the output directory). Objects are skipped when both their modification timestamp and content hash match the cached values.

`--force` re-exports everything and rewrites the cache. Use it after changing output format options.

## Logging

| Flag        | Default | Description |
|-------------|---------|-------------|
| `--verbose` | `false` | Debug-level output — per-object progress, batch timings, link resolution details. |
| `--quiet`   | `false` | Suppress all output except errors. Useful in scripts and CI. |

## Exit codes

| Code | Meaning |
|------|---------| 
| `0`  | Success — all objects exported (or skipped as unchanged) |
| `1`  | Partial failure — one or more objects failed, run completed |
| `3`  | Fatal — Anytype is not running, or authentication failed |

```bash
anytype-export --quiet || echo "Export failed with code $?"
```

---

## Output format

### Frontmatter fields

Every exported `.md` file starts with a YAML block. Fields are emitted in this order:

```yaml
---
title: James Clear
description: American writer and author of Atomic Habits.
aliases:
  - James Clear
tags:
  - person
created: 2024-01-15T10:30:00.000Z
modified: 2024-03-20T08:00:00.000Z
anytype-id: bafyrei...
anytype-type: Note
anytype-layout: basic
anytype-note-status: Finished
anytype-zettelkasten-type: Permanent Note
---
```

#### Native fields (understood without plugins)

The following fields are recognised natively by Obsidian (≥ 1.9) and Logseq:

| Field | Format | Notes |
|-------|--------|-------|
| `title` | string | Object name from Anytype |
| `description` | string | Object description, if present |
| `aliases` | list | Original object name — enables searching and linking by title even when the slug differs. Required by Obsidian ≥ 1.9 in plural form. |
| `tags` | list | Mapped from Anytype's tag property |
| `cssclasses` | list | Not emitted — set manually in Obsidian if needed |

#### Date fields (`created`, `modified`)

`created` and `modified` are **not** native Obsidian properties. They are custom fields that the [Dataview plugin](https://blacksmithgu.github.io/obsidian-dataview/) recognises for querying and sorting. Without Dataview, they appear in the raw frontmatter but are not indexed automatically.

- Values are populated **only when Anytype returns them** in the API response. Some objects — especially older ones or certain system types — may not have these dates. The exporter never writes a fabricated timestamp.
- The format is controlled by `--date-format` (default: ISO 8601 — `2024-01-15T10:30:00.000Z`).

#### Custom properties (`anytype-*`)

All Anytype-specific properties that don't map to a standard field are prefixed with `anytype-`. This prevents collisions with built-in fields in Obsidian, Logseq, or other editors:

```yaml
anytype-note-status: In process
anytype-zettelkasten-type: Fleeting Note
anytype-life-topic:
  - Science
  - Productivity
```

The `anytype-` prefix is safe to query with Dataview:

```dataview
TABLE anytype-note-status, anytype-zettelkasten-type
WHERE anytype-type = "Note"
SORT created DESC
```

### Slugs

File names are generated from the object name: `"James Clear"` → `james-clear.md`. File extensions embedded in object names (e.g. bookmarks named after their source file like `Atomic_Habits.pdf`) are stripped before slugifying, producing `atomic-habits.md` instead of `atomic-habits.pdf.md`.

Slugs are stable across renames — once assigned they are stored in the cache and kept.

### Links

Internal object references are converted to `[[wikilinks]]`. The `aliases` field ensures that Obsidian and Logseq can resolve links by the original human-readable title even when the slug is a normalised form of it.

### Images and file embeds

Downloaded images are embedded as standard Markdown by default:

```markdown
![image](files/abc.png)
```

Obsidian also supports the wikilink embed syntax (enables resize):

```markdown
![[abc.png|300]]
```

This is controlled by the `embedStyle` setting in the code (currently not a CLI flag). Set it to `"wikilink"` if you prefer Obsidian-native embeds.

---

## Sets and Queries (Dataview stubs)

Anytype's Set and Collection objects are dynamic views — their content is computed at render time in the app. The API always returns an empty body for them.

By default, anytype-export leaves these files empty. If you enable `--dataview-queries`, the exporter injects a Dataview query stub as a best-effort approximation:

```bash
anytype-export --dataview-queries
```

The stub looks like this:

```markdown
\`\`\`dataview
TABLE anytype-note-status, anytype-zettelkasten-type, created
WHERE file.name != this.file.name
SORT created DESC
\`\`\`
```

> **Obsidian only.** The `dataview` code block is executed only by the [Dataview plugin](https://blacksmithgu.github.io/obsidian-dataview/) in Obsidian. In Logseq, SiYuan, AppFlowy, and other editors it renders as a plain text code block — the query is not executed. If you use a non-Obsidian vault, leave `--dataview-queries` off (the default).

---

## Editor compatibility

| Feature | Obsidian | Logseq | SiYuan | AppFlowy |
|---------|:--------:|:------:|:------:|:--------:|
| YAML frontmatter | ✅ | ✅ | ✅ | ✅ |
| `tags` (multi-line list) | ✅ | ✅ | ✅ | ✅ |
| `aliases` (multi-line list) | ✅ | ✅ | ✅ | — |
| `[[wikilinks]]` | ✅ | ✅ | ✅ | ✅ |
| `created` / `modified` (Dataview) | ✅ with plugin | — | — | — |
| `dataview` code blocks | ✅ with plugin | renders as text | renders as text | renders as text |
| `![image](files/...)` embeds | ✅ | ✅ | ✅ | ✅ |

---

## Examples

Daily incremental backup, full re-export every Sunday:

```bash
# crontab
0 3 * * 0   anytype-export --output ~/backup/anytype --force --quiet
0 3 * * 1-6 anytype-export --output ~/backup/anytype --quiet
```

Obsidian vault with personal notes only:

```bash
anytype-export \
  -o ~/Documents/ObsidianVault \
  --include-types Note,Journal,Task \
  --group-by-type \
  --create-index
```

Preview what would export before committing:

```bash
anytype-export --include-types Note --dry-run --verbose
```
