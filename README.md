# 🌿 anytype-export

Export your [Anytype](https://anytype.io) notes to [Obsidian](https://obsidian.md)-compatible markdown — with all images, links, and tags preserved.

## Requirements

- [Bun](https://bun.sh) runtime
- [Anytype](https://anytype.io) desktop app (must be running during login and export)

---

## Install

**Run from source** — clone and use `bun run`:
```bash
git clone https://github.com/you/anytype-export
cd anytype-export
bun install
bun run login
bun run export
```

**Install globally** — use `anytype-export` from anywhere:
```bash
bun install --global anytype-export
anytype-export login
anytype-export
```

**Compile to a standalone binary** — no Bun needed to run:
```bash
bun run build
./anytype-export login
./anytype-export
```

> The compiled binary runs on any machine — no Bun, no Node, no dependencies.

---

## Usage

### 1. Connect your account

```bash
anytype-export login    # or: bun run login
```

1. Open **Anytype** on your computer
2. Go to **Settings → API**
3. Enter the **4-digit code** shown there

Your credentials are saved securely to the OS keychain via `Bun.secrets` — macOS Keychain, GNOME Keyring on Linux, or Windows Credential Manager. No file is written to disk.

### 2. Export

```bash
anytype-export          # or: bun run export
```

Your notes appear in `./export/`, ready to open in Obsidian.

```bash
anytype-export -o ~/notes/anytype   # short flag
anytype-export --output ~/notes/anytype   # long flag
```

---

## Options

| Flag | Alias | Description |
|---|---|---|
| `--output DIR` | `-o` | Where to save files *(default: `./export`)* |
| `--force` | | Re-export everything, ignoring the cache |
| `--dry-run` | | Preview what would be exported without writing files |
| `--no-files` | | Skip downloading images and attachments |
| `--include-types Note,Task` | | Only export these object types |
| `--exclude-types Task` | | Skip these object types |
| `--group-by-type` | | Organise into subdirectories by type |
| `--create-index` | | Generate an `index.md` overview file |
| `--help` | `-h` | Show all flags |
| `--version` | `-v` | Print version |

```bash
anytype-export switch   # switch to a different space
anytype-export status   # show current account & space
anytype-export logout   # remove saved credentials
```

Flags accept both `=` and space separators:

```bash
anytype-export --output ~/notes    # space-separated
anytype-export --output=~/notes    # = sign
anytype-export -o ~/notes          # short alias
```

---

## What gets exported

| | |
|---|---|
| **Notes, Tasks, Bookmarks…** | All object types, including custom ones |
| **Properties** | Saved as YAML frontmatter |
| **Internal links** | Converted to Obsidian `[[wikilinks]]` |
| **Images & files** | Downloaded alongside your notes |
| **Fast reruns** | Only changed notes are re-exported |
| **Deletions** | Stale files are removed automatically |

> **Obsidian tip:** The `created` and `modified` frontmatter fields are recognised by the [Dataview plugin](https://blacksmithgu.github.io/obsidian-dataview/). Without Dataview, they appear as raw frontmatter but aren't indexed.

---

## Privacy

Everything stays on your machine. anytype-export talks only to the Anytype app running locally — no cloud, no third-party servers.

## License

MIT
