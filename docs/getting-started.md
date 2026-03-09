# Getting Started

Export your Anytype space to Obsidian-compatible markdown in three commands.

## Prerequisites

- [Bun](https://bun.sh) installed
- Anytype desktop app running on your machine

The exporter talks to Anytype's local daemon — nothing leaves your machine.

## Install

```bash
bun install -g anytype-export
```

Or run without installing:

```bash
bunx anytype-export
```

## Log in

```bash
anytype-export login
```

This triggers a PIN challenge inside Anytype. Approve it in the app, then pick which space to export. Credentials are saved to the OS keychain via `Bun.secrets` — macOS Keychain, GNOME Keyring on Linux, or Windows Credential Manager. No file is written to disk. You only do this once.

Already logged in but want a different space? Run `anytype-export switch` — no PIN required, re-picks from your saved API key.

## Run your first export

```bash
anytype-export
```

Files land in `./export/` by default. The first run fetches everything; subsequent runs only re-export objects that changed.

```
┌─────────────────────────────────────┐
│  🌿 anytype-export                  │
│  Export Anytype → Obsidian markdown │
└─────────────────────────────────────┘

Space:  My Second Brain
Output: ./export

📦 Fetching objects…
   → 847 objects found — fetching full content…
📎 Downloading 312 file(s)…
✍️  Exporting objects…

═══════════════════════════════
  Done!
═══════════════════════════════
  Exported : 847
  Skipped  : 0  (unchanged)
  Time     : 14.3s
═══════════════════════════════
```

## What you get

The output directory looks like this:

```
export/
├── james-clear.md
├── atomic-habits-chapter-1-excerpt.md
├── notes-to-work-on.md
├── files/
│   ├── bafyrei...png
│   └── bafyrei...jpg
└── .anytype-cache.json
```

Each `.md` file has YAML frontmatter compatible with Obsidian, Logseq, SiYuan, and other knowledge editors. Internal links are wikilinks (`[[slug]]`). Images are downloaded locally and referenced with relative paths.

## Common first-run recipes

Export to a specific folder:

```bash
anytype-export -o ~/notes/anytype
```

Preview without writing any files:

```bash
anytype-export --dry-run
```

Export only Notes and Tasks:

```bash
anytype-export --include-types Note,Task
```

Organize files into subdirectories by type:

```bash
anytype-export --group-by-type --output ~/vault
# → ~/vault/Note/my-note.md
# → ~/vault/Task/finish-docs.md
```

## After the first export

On every subsequent run, anytype-export reads `.anytype-cache.json` from the output directory. Objects whose content hash and modification date haven't changed are skipped instantly — large spaces export in seconds.

To force a full re-export (e.g. after changing output settings):

```bash
anytype-export --force
```

## Other commands

| Command                   | What it does                              |
|---------------------------|-------------------------------------------|
| `anytype-export status`   | Show which account and space are active   |
| `anytype-export switch`   | Pick a different space (no re-login)      |
| `anytype-export logout`   | Delete saved credentials                  |
| `anytype-export --help`   | Print all flags                           |
