# Tests

Unit tests for **anytype-export**, written with [Bun's built-in test runner](https://bun.sh/docs/cli/test).

---

## Running the tests

```bash
# Run all tests
bun test

# Watch mode — re-runs on file save
bun test --watch

# Run a single file
bun test tests/Exporter.test.ts

# Verbose output (shows individual test names)
bun test --verbose
```

Tests run entirely in-process with no network access. HTTP calls are intercepted via `spyOn(globalThis, 'fetch')`. File I/O tests use temporary directories under `os.tmpdir()` that are cleaned up in `afterEach`.

---

## Test files

| File | What it tests |
|------|---------------|
| `AnytypeClient.test.ts` | HTTP error classification (`ECONNREFUSED`, 401/403/410/429/5xx), retry and backoff logic, pagination (`has_more` field, chunk-size heuristic), `getObjectsBatched` progress callbacks and per-object failure fallback, API version mismatch warning. |
| `CacheManager.test.ts` | `load` — fresh start on missing file, version/spaceId mismatch, and corrupt JSON. `save` — dirty-flag no-op, round-trip persistence. `isUnchanged` — timestamp + hash matching. `getDeletedIds` — detects removed objects. `remove` / `getCachedSlug`. `CacheManager.hash` — 16-char hex output, determinism. Regression test for optional `typeName` field (forward-compat with older cache files). |
| `Exporter.test.ts` | `generateSlug` — name-based slugs, file-extension stripping, accent removal, collision resolution (ID suffix → numeric counter), `slugStyle: "id"`. `extractContent` — CRLF normalisation, leading `---` artifact stripping, blank-line collapse, HTML entity decoding, trailing-whitespace removal, description/snippet fallback, Dataview stub injection. `buildFrontmatter` — all standard fields (`title`, `aliases`, `description`, `tags`, `created`, `modified`), Quartz extras, `preserveIds`, SKIP_KEYS enforcement, `anytype-` prefix for custom properties. `assemble` — frontmatter + content joining. |
| `FileWriter.test.ts` | `ensureOutputDir` — creates `files/` subdirectory, skips it when `includeFiles=false`, idempotent. `writeMarkdown` — flat output, `groupByType` subdirectory routing, type-name sanitisation, dry-run no-op. `deleteMarkdown` — removes file, no-op on missing, dry-run no-op. `downloadFile` — MIME-to-extension detection, no double-extension (regression test), fallback to next URL on 404, all-fail → `null`, file-size limit enforcement, already-downloaded skip, dry-run path without fetching. `writeIndex` — grouped links, alphabetical type sort. |
| `LinkTransformer.test.ts` | Named markdown links (`[text](anytype://…)`) — alias vs no-alias, `aliasLinks=false`, anchor fragments. Bare query/path URLs. Embed links (`![alt](anytype://…)`) — default wikilink style, `embedStyle: "markdown"`, `detectEmbeds=false`. Broken links — `keep` / `remove` / `warn` styles. Code block protection — fenced and inline code are never modified. Transform stats (transformed + broken counts). `buildSlugMap` — slug generation, collision resolution, `"Untitled"` fallback. |

---

## Test conventions

- **No network.** All `fetch` calls are mocked with `spyOn(globalThis, 'fetch')` and restored in `afterEach`.
- **No real keychain.** `secrets.ts` is not tested directly; `credStore` is bypassed in the CLI by injecting credentials via config objects.
- **Temporary directories.** `FileWriter` and `CacheManager` tests create isolated temp dirs via `mkdtemp` and clean them up after each test.
- **Zero config.** Tests import `DEFAULT_CONFIG` from `types.ts` and override only the fields under test, so tests don't break when new config fields are added.
- **Regression labels.** Tests that cover a previously fixed bug include a `(BUG N regression)` suffix in the `describe` label so they are easy to identify in output.
