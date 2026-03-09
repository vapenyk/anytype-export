# Code Style & Commenting Guide

> **For everyone.** This document explains how we write comments in this project and why.

---

## Philosophy

Comments explain **why**, not what. The code explains the what. TypeScript types explain the shape.

A good comment answers: *"What problem does this solve?"* or *"Why is it done this way?"* — not *"This function returns a string."*

---

## File headers

Every `.ts` file starts with a JSDoc block that describes what the file is for. One to three sentences. End with `@module` (or `@packageDocumentation` for the entry point `cli.ts`).

```ts
/**
 * Orchestrates the full Anytype → Obsidian export pipeline.
 *
 * Steps: fetch objects → build slug map → download files → write markdown → update cache.
 *
 * @module
 */
```

Keep it short. If someone has to read more than three sentences to understand what the file does, the file is probably doing too much.

---

## Classes and exported functions

Use a JSDoc block. One-line summary on the first line. Add a paragraph if the behaviour is non-obvious. Omit `@param` / `@returns` when the TypeScript signature already makes them clear.

```ts
/**
 * Produce a unique, filesystem-safe slug for an object.
 *
 * Collision resolution: bare name → name + ID suffix → name + numeric counter.
 */
generateSlug(name: string, id: string, existingSlugs: Set<string>): string {
```

For private helpers that are short and obviously named, a single `/** One line. */` is enough. For getters and trivially obvious methods, skip the block entirely.

---

## Inline comments

Use `//` for anything that doesn't fit naturally in a JSDoc block: non-obvious constants, tricky logic, important constraints.

```ts
// NOTE: 12 chars gives enough uniqueness (296 billion combinations in base62)
// while keeping slugs short enough to be readable in a file browser.
const idSlug: string = id.slice(-12);
```

Use `// NOTE:` for non-obvious decisions. Use `// TODO:` for known future work. Use `// WARN:` for gotchas that can bite.

---

## What NOT to comment

```ts
// BAD — restates what the code already says
const users = getUsers(); // get users

// BAD — obvious return
return null; // return null

// GOOD — explains a constraint that isn't visible from the code
const hash = content.slice(0, 16); // 16-char prefix matches CacheEntry.contentHash
```

---

## Interfaces and types

Use a JSDoc block for exported interfaces. Use inline `//` comments for non-obvious fields.

```ts
/**
 * Per-object record stored in `.anytype-cache.json`.
 *
 * If both `lastModified` and `contentHash` match on the next run,
 * the object is unchanged and can be skipped.
 */
export interface CacheEntry {
  slug: string;         // slug at last export (preserved for link integrity)
  lastModified: string; // ISO timestamp from API
  contentHash: string;  // 16-char SHA-256 prefix of rendered content
}
```

---

## Shell scripts (`.sh`)

```sh
# filename.sh — one-line description
# Loaded by: what sources/calls this file

# functionName — what it does
functionName() {
    local conf="$HOME/.config/dotfiles/motd.conf"  # created if missing
    ...
}
```

---

## Naming conventions

| Thing | Style | Example |
|---|---|---|
| TypeScript files | PascalCase for classes, lowercase for utils | `AnytypeClient.ts`, `logger.ts` |
| TypeScript classes | PascalCase | `ExportPipeline` |
| TypeScript functions | camelCase | `buildSlugMap` |
| TypeScript constants | SCREAMING_SNAKE | `DAEMON_URL` |
| Shell scripts | `NN-kebab-case.sh` | `40-functions.sh` |

---

## Checklist before committing

- [ ] Does the **file header** describe what this file does in 1–3 sentences?
- [ ] Do **exported classes and functions** have a JSDoc block or at least a one-liner?
- [ ] Do **non-obvious decisions** have a `// NOTE:` comment?
- [ ] Are there any **dead comments** (commented-out code, stale TODOs)?
- [ ] Would a **developer new to the project** understand where to start?
