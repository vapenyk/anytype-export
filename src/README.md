# Source

TypeScript source modules for **anytype-export**.

All files target [Bun](https://bun.sh) and use zero runtime dependencies — YAML, hashing, credential storage, and HTTP are all handled by Bun built-ins.

---

## Module map

### Entry point

| File | Role |
|------|------|
| `cli.ts` | CLI entry point. Parses `process.argv`, loads credentials, and dispatches to command handlers (`login`, `export`, `switch`, `status`, `logout`). |

### Pipeline

| File | Role |
|------|------|
| `ExportPipeline.ts` | Orchestrates the complete export run across eight steps: setup → fetch → slug map → file downloads → markdown export → deletions → index → cache flush. |
| `Exporter.ts` | Transforms a single `FullObject` into an Obsidian-compatible `.md` file. Handles slug generation, YAML frontmatter assembly, content cleaning, and date formatting. |
| `LinkTransformer.ts` | Converts `anytype://object?objectId=…` and `anytype://object/…` URLs to Obsidian `[[wikilinks]]`. Protects fenced code blocks and inline code from transformation. |
| `FileWriter.ts` | All filesystem I/O: creates directories, writes markdown, downloads attachments, deletes stale files, and generates `index.md`. Respects `--dry-run`. |
| `CacheManager.ts` | Reads and writes `.anytype-cache.json` for incremental exports. Tracks each object's slug, last-modified timestamp, and content hash to detect changes. |

### API / auth

| File | Role |
|------|------|
| `AnytypeClient.ts` | Authenticated HTTP client for the Anytype local daemon (port 31009). Provides paginated getters for spaces, objects, types, members, and list views. Handles retries, rate limiting, and typed error classes. |
| `AuthFlow.ts` | PIN-based authentication flow. Requests a challenge from the daemon, prompts the user for the 4-digit PIN shown in Anytype Settings → API, and exchanges it for an API key. Also handles space selection. |
| `secrets.ts` | OS keychain credential store via `Bun.secrets`. Saves and loads API key, space ID, space name, and gateway URL as a single atomic JSON blob. No credentials are written to disk. |

### Utilities

| File | Role |
|------|------|
| `types.ts` | All shared TypeScript types: Anytype API wire types (`FullObject`, `ObjectSummary`, `PropertyValue`, …), pipeline-internal types (`SlugMap`, `CacheEntry`, …), and the complete `ExportConfig` with `DEFAULT_CONFIG`. |
| `logger.ts` | Levelled console logger with ANSI colour helpers. Exposes `debug`, `info`, `warn`, `error`, `success`, and an in-place `progress` bar. |
| `hash.ts` | `contentHash(content)` — returns a 16-char SHA-256 hex prefix, used for cache invalidation. Defined separately to avoid a circular dependency between `Exporter` and `CacheManager`. |
| `html.ts` | `decodeHtmlEntities(text)` — strips the HTML entities that Anytype's markdown renderer occasionally leaks into its output (`&#39;`, `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&nbsp;`, `\_`). |

---

## Data flow

```
cli.ts
  └─ ExportPipeline.run()
       ├─ AnytypeClient      → fetch objects from daemon
       ├─ LinkTransformer    → build slug map, transform links
       ├─ Exporter           → render frontmatter + content
       ├─ FileWriter         → write .md files, download attachments
       └─ CacheManager       → skip unchanged objects, flush cache
```

Credentials flow: `secrets.ts` → `cli.ts` → `ExportPipeline` (via `ExportConfig`) → `AnytypeClient`.

---

## Key constants

All network constants live in `AnytypeClient.ts` and are re-exported from there so `types.ts`, `AuthFlow.ts`, and the CLI share a single source of truth:

| Constant | Value | Used for |
|----------|-------|----------|
| `DAEMON_URL` | `http://127.0.0.1:31009` | All REST API calls |
| `GATEWAY_URL` | `http://127.0.0.1:47800` | File/image downloads |
| `API_VERSION` | `2025-11-08` | `Anytype-Version` request header |
| `APP_NAME` | `anytype-export` | Auth challenge identifier |
