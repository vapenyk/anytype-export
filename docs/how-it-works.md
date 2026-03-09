---
title: "How It Works"
description: "A walkthrough of the eight-step export pipeline — from API fetch to final markdown files."
---

# How It Works

anytype-export talks to Anytype's local daemon over HTTP — the same process the desktop app itself uses. Nothing leaves your machine. Each export run executes eight steps in sequence.

## The pipeline

### 1. Setup

The output directory is created if it doesn't exist. The cache file (`.anytype-cache.json`) is loaded from the output directory. If `--force` is passed or the cache is absent, every object is treated as new.

### 2. Fetch

`AnytypeClient.getObjects()` calls `/spaces/:id/objects` and returns a flat list of every object in the space.

**Server-side pre-filtering:** When `--include-types` is set, the type names are forwarded to the API as a query parameter (`?type_key=note,task`). The daemon filters the list before sending it over the wire, reducing payload size significantly for large spaces.

The list is then filtered client-side:

- Archived objects are skipped by default
- System objects with no name or snippet are dropped
- Type filters from `--include-types` and `--exclude-types` are applied

The filtered list doesn't include markdown bodies. `getObjectsBatched()` then fetches full content for each object in parallel batches of 10, with a 500ms delay between batches to avoid overwhelming the daemon.

### 3. Slug map

Before any files are written, a lookup table is built: **object ID → file slug**. This happens upfront because link transformation in step 5 needs the final filename of every object — including ones that haven't changed and won't be re-exported this run.

Slugs are generated from the object name (`"James Clear"` → `"james-clear"`). File extensions embedded in names (e.g. bookmark objects named after their source PDF) are stripped before normalisation — `"Atomic_Habits.pdf"` becomes `"atomic-habits"` instead of `"atomic-habits.pdf"`. Collisions are resolved by appending a short ID suffix.

Slugs for objects deleted since the last run are preserved from the cache — wikilinks to those objects continue to resolve correctly.

### 4. File downloads

Unless `--no-files` is set, every object's markdown body and properties are scanned for local image and attachment URLs. Cover images and file icons are also collected.

Each unique file is downloaded once into `export/files/` with a stable filename based on its content ID. A file already downloaded in a previous run is skipped.

### 5. Export

For each object the pipeline does five things:

**Cache check.** If the object's last-modified timestamp and a SHA-256 hash of its rendered content both match the cached values, the object is skipped. This is how subsequent runs finish in seconds.

**Frontmatter.** Type, dates, tags, and other properties become YAML frontmatter. The following fields are emitted:

- `title` — object name
- `aliases` — original object name as a list. This is required by Obsidian ≥ 1.9 (plural form) and ensures that `[[wikilinks]]` resolve correctly by title even when the file slug is a normalised form.
- `tags` — from Anytype's tag relation
- `created` / `modified` — ISO 8601 timestamps from the API. These are **not** native Obsidian properties; they are recognised by the [Dataview plugin](https://blacksmithgu.github.io/obsidian-dataview/) only. They are emitted only when the Anytype API returns them — some objects may not have these dates.
- `anytype-*` — all other Anytype properties, prefixed to avoid collisions with built-in fields in Obsidian, Logseq, and other editors.

**Link transformation.** `anytype://object?objectId=<id>` URLs are converted to `[[slug]]` wikilinks using the slug map from step 3. Links to objects not found in the map follow `brokenLinkStyle` — kept as-is by default.

**File URL rewriting.** Embedded local image URLs are replaced with relative paths pointing to the downloaded files from step 4.

**Write.** The assembled markdown is written to disk. Intermediate directories are created automatically.

### 6. Deletions

The cache tracks every object exported in previous runs. Any cached object absent from the current API response was deleted in Anytype — its `.md` file is removed and its cache entry is dropped.

### 7. Index

If `--create-index` is set, an `index.md` is written to the output root listing all exported objects grouped by type, each linking to its slug.

### 8. Cache flush

The updated `.anytype-cache.json` is written to disk. The cache records each object's slug, last-modified timestamp, and content hash. On the next run, only changed objects are re-exported.

---

## Sets and Queries

Anytype's Set and Collection objects are dynamic views — their content is computed at render time in the app. The API always returns an empty body for them.

By default, anytype-export exports these as empty markdown files with frontmatter only. The flag `--dataview-queries` (default: `false`) injects a Dataview query stub as a best-effort approximation of the Set's filter:

```markdown
\`\`\`dataview
TABLE anytype-note-status, anytype-zettelkasten-type, created
WHERE file.name != this.file.name
SORT created DESC
\`\`\`
```

**Editor compatibility:** The `dataview` code block is executed only by the [Dataview plugin](https://blacksmithgu.github.io/obsidian-dataview/) inside Obsidian. In Logseq, SiYuan, AppFlowy, and any other editor, it renders as a plain text code block — the query is not executed and no dynamic table is shown. Keep `--dataview-queries` off (the default) if you use a non-Obsidian vault.

---

## Credential storage

Credentials (API key, space ID) are stored in the OS keychain via `Bun.secrets`:
- **macOS** → Keychain Services
- **Linux** → libsecret (GNOME Keyring / KWallet)
- **Windows** → Windows Credential Manager

Credentials are encrypted at rest by the operating system. No files are written to disk.

---

## Key design decisions

**No config file.** All options are CLI flags. Credentials are the only thing persisted — to the OS keychain. This makes the tool composable in scripts: the full behaviour is visible in one command.

**Cache checks both timestamp and hash.** The API's `last_modified_date` field alone isn't reliable — Anytype sometimes updates it without changing content. The SHA-256 hash of the rendered body catches real changes and prevents unnecessary re-exports.

**Slugs strip file extensions.** Anytype bookmark objects often carry a filename (e.g. `Atomic_Habits.pdf`) as their display name. Stripping the extension before slugifying prevents double-extension filenames like `atomic-habits.pdf.md`.

**`aliases` for stable link resolution.** Every exported note includes the original Anytype name in the `aliases` frontmatter field. This means Obsidian and Logseq can resolve `[[James Clear]]` even if the file is named `james-clear.md`. Obsidian ≥ 1.9 requires the plural `aliases` key (not `alias`).

**Slugs are stable across renames.** Once a slug is assigned to an object ID it's stored in the cache. Renaming a note in Anytype generates a new slug for future runs, but the old slug file is overwritten in place so wikilinks in other notes continue to work.

**Batched fetching with rate limiting.** Full-content fetching requires one HTTP request per object. The pipeline fetches in parallel batches (`batchSize: 10`) with a configurable delay between batches (`rateLimitDelay: 500ms`) to stay within the daemon's limits.

**Daemon vs gateway.** Anytype exposes two local servers: the daemon on port 31009 (requires a Bearer token, always authoritative) and a gateway on port 47800 (no auth, used for media). anytype-export authenticates with the daemon and falls back to the gateway URL only for file downloads when the daemon cannot serve a particular content ID.

**Server-side type filtering.** When `--include-types` is set, type names are sent as query parameters for pre-filtering on the daemon side. This avoids downloading the full object list in large spaces. Client-side filtering is still applied as the authoritative step.

**Zero runtime dependencies.** `package.json` has no entries in `dependencies`. YAML serialisation, file I/O, hashing, credential storage, and stdin input are all handled by Bun's built-in APIs. The only `devDependency` is `ts-morph`, used exclusively by `scripts/generate-docs.ts`.
