/**
 * All shared TypeScript types for anytype-export.
 *
 * Covers Anytype API wire types, pipeline-internal structures, cache schema,
 * and the full `ExportConfig` with its defaults.
 *
 * API version tracked: 2025-11-08
 *
 * @packageDocumentation
 */

import {
  DAEMON_URL,
  GATEWAY_URL,
  API_VERSION,
} from "./AnytypeClient.ts";

// ── Anytype API Types ─────────────────────────────────────────────────────────

/** Emoji, uploaded file, or named built-in icon. `format` discriminates which field is set. */
export interface IconObject {
  format?: "emoji" | "file" | "icon";
  emoji?: string;
  file?: string;  // file CID when format === "file"
  name?: string;  // built-in icon name when format === "icon"
  color?: string; // optional tint for built-in icons
}

/** The Anytype type assigned to an object (Note, Task, etc.). */
export interface ObjectType {
  id: string;
  name: string;
  icon?: IconObject;
  recommended_properties?: string[];
}

/** A single value in a select or multi-select property. */
export interface SelectOption {
  id?: string;
  name: string;
  color?: string;
}

/**
 * A single property on an object.
 *
 * `format` discriminates which value field is populated. The API returns
 * exactly one value field per property; the rest are absent.
 */
export interface PropertyValue {
  key: string;
  name: string;
  /** Matches API PropertyFormat enum */
  format?:
    | "text"
    | "number"
    | "select"
    | "multi_select"
    | "date"
    | "files"
    | "checkbox"
    | "url"
    | "email"
    | "phone"
    | "objects";
  // Value variants — only one is populated per format:
  text?: string;
  number?: number;
  checkbox?: boolean;
  date?: string | number;
  url?: string;
  email?: string;
  phone?: string;
  emoji?: string;
  select?: SelectOption;
  multi_select?: SelectOption[];
  objects?: string[]; // linked object IDs
  files?: string[];   // file CIDs
}

/** All layout types returned by the API. File-type layouts identify objects that ARE the file. */
export type ObjectLayout =
  | "basic"
  | "profile"
  | "action"
  | "note"
  | "bookmark"
  | "set"
  | "collection"
  | "participant"
  | "file"
  | "image"
  | "video"
  | "audio"
  | "pdf";

/** Layouts that represent file objects rather than content documents. */
export const FILE_LAYOUTS: ReadonlySet<string> = new Set([
  "file",
  "image",
  "video",
  "audio",
  "pdf",
]);

/**
 * Lightweight object returned by the `/objects` list endpoint.
 * Does NOT include the markdown body — use `FullObject` for that.
 */
export interface ObjectSummary {
  id: string;
  name?: string;
  snippet?: string;
  type?: ObjectType;
  icon?: IconObject;
  cover?: string; // file CID or URL of the cover image
  layout?: ObjectLayout | string;
  archived?: boolean;
  created_date?: string | number; // Unix timestamp (seconds) or ISO string
  last_modified_date?: string | number;
}

/** `ObjectSummary` plus full content from `/objects/:id?format=md`. */
export interface FullObject extends ObjectSummary {
  markdown?: string;    // rendered markdown body
  description?: string; // plain-text description property
  properties?: PropertyValue[];
}

/** Object type from `/spaces/:id/types`. */
export interface TypeDefinition {
  id: string;
  name: string;
  icon?: IconObject;
  description?: string;
  recommended_properties?: string[];
}

/**
 * Workspace/space from `/spaces` or `/spaces/:id`.
 * `gateway_url` is saved at login time and used for file downloads.
 */
export interface SpaceInfo {
  id: string;
  name?: string;
  icon?: IconObject;
  description?: string;
  gateway_url?: string; // e.g. "http://127.0.0.1:47800" — varies per installation
}

/** Space member from `/spaces/:id/members`. */
export interface MemberInfo {
  id: string;
  name?: string;
  icon?: IconObject;
  role?: string;
  status?: string;
}

/** A view inside a Set/Collection, from `/lists/:id/views`. */
export interface ListView {
  id: string;
  name?: string;
  type?: string;
}

// ── Export / Internal Types ───────────────────────────────────────────────────

/**
 * Maps Anytype object IDs to their exported file slugs.
 * Built once per export run by `LinkTransformer.buildSlugMap()`.
 */
export interface SlugMapEntry {
  slug: string; // e.g. "james-clear"
  name: string; // original object name — used for alias detection
  type: string; // object type name — used for type-grouped exports
}
export type SlugMap = Record<string, SlugMapEntry>; // objectId → entry

// ── Cache Types ───────────────────────────────────────────────────────────────

/**
 * Per-object record stored in `.anytype-cache.json`.
 *
 * If both `lastModified` and `contentHash` match on the next run,
 * the object is unchanged and can be skipped.
 */
export interface CacheEntry {
  slug:         string;         // slug at last export (preserved for link integrity)
  lastModified: string; // ISO timestamp from API
  contentHash:  string;  // 16-char SHA-256 prefix of rendered content
  typeName?:    string;  // object type name — required for deleteMarkdown when groupByType=true
}

/**
 * The full `.anytype-cache.json` structure written to disk.
 * `version` is checked on load — a mismatch triggers a fresh full export.
 */
export interface CacheData {
  version: string;    // bumped when cache schema changes
  spaceId: string;    // cache is space-scoped; mismatch triggers fresh export
  exportDate: string; // ISO timestamp of last successful export
  objects: Record<string, CacheEntry>;
  settings: {
    outputDir: string;
    includeFiles: boolean;
  };
}

// ── Configuration Types ───────────────────────────────────────────────────────

export type SlugStyle      = "name" | "id" | "hybrid";
export type FrontmatterStyle = "obsidian" | "quartz" | "minimal";
export type DateFormat     = "iso" | "locale" | "timestamp";
export type BrokenLinkStyle = "keep" | "remove" | "warn";
export type EmbedStyle     = "wikilink" | "markdown" | "html";

/**
 * Complete runtime configuration for one export run.
 * Populated by the CLI from saved credentials and CLI flags.
 * `DEFAULT_CONFIG` provides sensible defaults for all optional fields.
 */
export interface ExportConfig {
  // ── API ──────────────────────────────────────────────────────────────────────
  apiKey: string;       // Bearer token from login
  spaceId: string;      // target space (saved at login, overridable)
  spaceName: string;    // human-readable name — shown in index.md and UI
  baseUrl: string;      // daemon URL — always http://127.0.0.1:31009
  gatewayUrl?: string;  // from space.gateway_url — used for file downloads
  apiVersion: string;   // Anytype-Version header value

  // ── Output ───────────────────────────────────────────────────────────────────
  outputDir: string;
  force: boolean;       // ignore cache, re-export everything
  dryRun: boolean;      // preview only — no files written
  incremental: boolean; // use cache for skip detection
  skipCache: boolean;   // skip reading cache (still writes at end)

  // ── Content ──────────────────────────────────────────────────────────────────
  includeFiles: boolean;    // download images and attachments
  filesDir: string;         // subdirectory for downloaded files
  maxFileSizeMb: number;    // skip files larger than this
  skipEmpty: boolean;       // skip objects with no content
  skipArchived: boolean;    // skip archived objects
  includeTypes: string[];   // allowlist (empty = all types)
  excludeTypes: string[];   // denylist
  batchSize: number;        // parallel object fetches per batch
  rateLimitDelay: number;   // ms to wait between batches

  // ── Format ───────────────────────────────────────────────────────────────────
  slugStyle: SlugStyle;
  frontmatterStyle: FrontmatterStyle;
  dateFormat: DateFormat;
  preserveIds: boolean;     // add anytype-id to frontmatter
  groupByType: boolean;     // output/types/Note/slug.md instead of output/slug.md
  createIndex: boolean;     // generate index.md overview
  // Inject a Dataview query stub into empty Set / Collection pages.
  // Obsidian-only: other editors render it as a plain code block.
  // See: https://blacksmithgu.github.io/obsidian-dataview/
  dataviewQueries: boolean;

  // ── Links ────────────────────────────────────────────────────────────────────
  transformLinks: boolean;      // convert anytype:// → [[wikilinks]]
  brokenLinkStyle: BrokenLinkStyle;
  detectEmbeds: boolean;        // convert ![](anytype://…) → ![[wikilinks]]
  embedStyle: EmbedStyle;
  aliasLinks: boolean;          // [[slug|alias]] when link text ≠ object name

  // ── Performance ──────────────────────────────────────────────────────────────
  maxRetries: number;
  retryDelay: number;   // ms, exponential multiplied by attempt number
  timeout: number;      // ms per request

  // ── Logging ──────────────────────────────────────────────────────────────────
  logLevel: "debug" | "info" | "warn" | "error";
  verbose: boolean;     // shorthand for logLevel: "debug"
  quiet: boolean;       // shorthand for logLevel: "error"
}

/**
 * Sensible defaults for all `ExportConfig` fields.
 *
 * `DAEMON_URL`, `GATEWAY_URL`, and `API_VERSION` are imported from `AnytypeClient`
 * so there is a single source of truth for those constants.
 */
export const DEFAULT_CONFIG: ExportConfig = {
  // API
  apiKey: "",
  spaceId: "",
  spaceName: "",    // populated from saved credentials at export time
  baseUrl: DAEMON_URL,      // http://127.0.0.1:31009 — Anytype daemon
  gatewayUrl: GATEWAY_URL,  // http://127.0.0.1:47800 — overwritten from space at login
  apiVersion: API_VERSION,  // 2025-11-08

  // Output
  outputDir: "./export",
  force: false,
  dryRun: false,
  incremental: true,
  skipCache: false,

  // Content
  includeFiles: true,
  filesDir: "files",
  maxFileSizeMb: 50,
  skipEmpty: false,
  skipArchived: true,
  includeTypes: [],
  excludeTypes: [],
  batchSize: 10,
  rateLimitDelay: 500,

  // Format
  slugStyle: "hybrid",
  frontmatterStyle: "obsidian",
  dateFormat: "iso",
  preserveIds: true,
  groupByType: false,
  createIndex: false,
  dataviewQueries: false, // opt-in — Obsidian-only, won't render in Logseq/SiYuan

  // Links
  transformLinks: true,
  brokenLinkStyle: "keep",
  detectEmbeds: true,
  embedStyle: "wikilink",
  aliasLinks: true,

  // Performance
  maxRetries: 3,
  retryDelay: 1000,
  timeout: 30_000,

  // Logging
  logLevel: "info",
  verbose: false,
  quiet: false,
};
