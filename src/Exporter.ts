/**
 * Transforms an Anytype `FullObject` into Obsidian-compatible markdown.
 *
 * The pipeline calls these methods individually rather than an all-in-one method
 * because it needs the raw content for cache hashing before frontmatter is built.
 *
 * @module
 */

import { YAML } from "bun";
import type {
  FullObject,
  PropertyValue,
  ExportConfig,
  SlugStyle,
  FrontmatterStyle,
  DateFormat,
} from "./types.ts";
import { contentHash } from "./hash.ts";
import { decodeHtmlEntities } from "./html.ts";
import { Logger } from "./logger.ts";

// ── Module-level constants ────────────────────────────────────────────────────

// Top-level FullObject fields handled explicitly in buildFrontmatter.
// Any PropertyValue whose key matches one of these is skipped to avoid
// duplicating data that is already mapped to standard frontmatter fields.
const SYSTEM_KEYS = new Set([
  "id", "name", "type", "icon", "cover", "layout", "archived",
  "created_date", "last_modified_date", "description", "snippet", "backlinks",
]);

// Internal/noisy Anytype fields that add no value in Obsidian.
// Covers all variants the API may return (snake_case, kebab-case, camelCase).
const SKIP_KEYS = new Set([
  "links", "backlinks",
  "created_by", "created-by", "createdby",
  "last_modified_by", "last-modified-by", "lastmodifiedby",
  "last_edited_by", "last-edited-by", "lasteditedby",
  "author",
  "last_modified_date", "last-modified-date", "lastmodifieddate",
  "created_date", "created-date", "createddate",
  "last_opened_date", "last-opened-date", "lastopeneddate",
  "featured_relations", "featured-relations", "featuredrelations",
  "cover", "template",
  "space_id", "space-id", "spaceid",
  "workspace_id", "workspace-id", "workspaceid",
  "sync_status", "sync-status", "syncstatus",
]);

// Frontmatter field names returned as-is without an "anytype-" prefix.
// Declared at module level to avoid re-allocating the Set on every normalizeKey() call.
const STANDARD_KEYS = new Set(["title", "tags", "created", "modified", "description", "date"]);

// ── Exporter ──────────────────────────────────────────────────────────────────

/** Stateless per-object transformer; config is injected via the constructor. */
export class Exporter {
  private readonly config: ExportConfig;
  private readonly logger: Logger;

  constructor(config: ExportConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger ?? new Logger();
  }

  // ── Slug generation ─────────────────────────────────────────────────────────

  /**
   * Produce a unique, filesystem-safe slug for an object.
   *
   * Slug styles:
   * - `"name"` — slugified object name only (e.g. `"james-clear"`)
   * - `"id"` — last 12 chars of the object ID (always unique, never readable)
   * - `"hybrid"` — name-based with ID suffix only on collision (default)
   *
   * Collision resolution: bare name → name + ID suffix → name + numeric counter.
   */
  generateSlug(name: string, id: string, existingSlugs: Set<string>): string {
    const style: SlugStyle = this.config.slugStyle;
    const nameSlug: string = this.slugify(name);
    // NOTE: 12 chars gives enough uniqueness (296 billion combinations in base62)
    // while keeping slugs short enough to be readable in a file browser.
    const idSlug: string = id.slice(-12);

    let candidate: string;
    switch (style) {
      case "id":   candidate = idSlug; break;
      case "name": candidate = nameSlug || idSlug; break;
      default:     candidate = nameSlug || idSlug; break; // 'hybrid'
    }

    if (!existingSlugs.has(candidate)) return candidate;

    const withId = `${candidate}-${idSlug}`;
    if (!existingSlugs.has(withId)) return withId;

    let n = 2;
    while (existingSlugs.has(`${candidate}-${n}`)) n++;
    return `${candidate}-${n}`;
  }

  /**
   * Convert an arbitrary string to a safe filename/URL slug.
   *
   * Steps:
   * 1. Strip trailing file extension (e.g. `.pdf`) to avoid slugs like `"chapter-1.pdf"`
   * 2. Lowercase + NFD normalise to remove combining diacritics (`é` → `e`)
   * 3. Strip filesystem-unsafe characters; preserves Unicode letters/digits
   * 4. Collapse whitespace to hyphens; collapse repeated hyphens; trim
   * 5. Truncate to 80 chars
   */
  private slugify(str: string): string {
    let s = str.replace(/\.[a-z0-9]{2,5}$/i, "");
    s = s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    s = s
      .replace(/[\\/:*?"<>|#%&{}\[\]^`~!@$=+;,\'()]/g, " ")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    return s || "untitled";
  }

  // ── Frontmatter ─────────────────────────────────────────────────────────────

  /**
   * Assemble the YAML frontmatter `Record` for an object.
   *
   * Fields emitted (in order): `title`, `description`, `aliases`, `tags`,
   * `created`, `modified`, Quartz extras, `anytype-id`, `anytype-type`,
   * `anytype-layout`, `anytype-cover`, then all remaining custom properties
   * prefixed with `anytype-`.
   */
  buildFrontmatter(obj: FullObject): Record<string, unknown> {
    const fm: Record<string, unknown> = {};
    const style: FrontmatterStyle = this.config.frontmatterStyle;

    fm.title = obj.name || obj.snippet || "Untitled";

    if (obj.description) fm.description = obj.description;

    // aliases — preserves the original human-readable name so Obsidian ≥ 1.9
    // can resolve wikilinks by title even after slug normalisation.
    if (obj.name) fm.aliases = [obj.name];

    const tagProp = (obj.properties ?? []).find(
      (p) => p.key === "tag" || p.key === "tags" || p.name?.toLowerCase() === "tag",
    );
    if (tagProp?.multi_select?.length) {
      fm.tags = tagProp.multi_select.map((s) => s.name);
    }

    const created  = this.getCreated(obj);
    const modified = this.getLastModified(obj);
    if (created)  fm.created  = this.formatDate(created);
    if (modified) fm.modified = this.formatDate(modified);

    if (style === "quartz") {
      if (created)  fm.date    = this.formatDate(created);
      if (modified) fm.lastmod = this.formatDate(modified);
    }

    if (this.config.preserveIds) {
      fm["anytype-id"]   = obj.id;
      fm["anytype-type"] = obj.type?.name ?? "";
    }

    if (obj.layout) fm["anytype-layout"] = obj.layout;
    if (obj.cover)  fm["anytype-cover"]  = obj.cover;

    const alreadyMapped = new Set([
      "tag", "tags", "created_date", "last_modified_date", "added_date",
      "name", "description", "icon", "cover",
      "created_by", "created-by", "last_modified_by", "last-modified-by",
      "space_id", "space-id", "workspace_id", "workspace-id",
    ]);

    for (const prop of obj.properties ?? []) {
      const keyLower = prop.key.toLowerCase();

      if (SYSTEM_KEYS.has(prop.key))     continue;
      if (SKIP_KEYS.has(keyLower))       continue;
      if (alreadyMapped.has(keyLower))   continue;

      const normName = (prop.name ?? "")
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
      if (SKIP_KEYS.has(normName)) continue;

      if ((keyLower === "added_date" || keyLower === "addeddate") && !fm.created) {
        const val = this.convertPropertyValue(prop);
        if (val) { fm.created = val; continue; }
      }

      const key     = this.normalizeKey(prop.key, prop.name);
      const stripped = key.replace(/^anytype-/, "");

      if (fm[stripped] !== undefined) continue;
      if ((stripped === "tag" || stripped === "tags") && fm.tags !== undefined) continue;

      const value = this.convertPropertyValue(prop);
      if (value !== null && value !== undefined) {
        fm[key] = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
      }
    }

    return fm;
  }

  /**
   * Convert a raw API property key to a safe frontmatter key.
   *
   * Standard field names are returned as-is. All others are prefixed with
   * `"anytype-"` to avoid collisions with Obsidian or Quartz built-in fields.
   *
   * NOTE: `STANDARD_KEYS` is a module-level constant — NOT recreated per call.
   */
  private normalizeKey(key: string, name?: string): string {
    const base = (name ?? key)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);

    return STANDARD_KEYS.has(base) ? base : `anytype-${base}`;
  }

  /** Extract the typed value from a `PropertyValue`. */
  private convertPropertyValue(prop: PropertyValue): unknown {
    switch (prop.format) {
      case "text":         return prop.text || undefined;
      case "number":       return prop.number;
      case "checkbox":     return prop.checkbox;
      case "url":          return prop.url || undefined;
      case "email":        return prop.email || undefined;
      case "phone":        return prop.phone || undefined;
      case "date":         return prop.date ? this.formatDate(String(prop.date)) : undefined;
      case "select":       return prop.select?.name;
      case "multi_select": return prop.multi_select?.length ? prop.multi_select.map((s) => s.name) : undefined;
      case "files":        return undefined; // raw CIDs — not useful in frontmatter
      case "objects":      return undefined; // raw IDs — already become wikilinks in content
      default:
        if (prop.text !== undefined)         return prop.text || undefined;
        if (prop.number !== undefined)       return prop.number;
        if (prop.checkbox !== undefined)     return prop.checkbox;
        if (prop.url)                        return prop.url;
        if (prop.email)                      return prop.email;
        if (prop.phone)                      return prop.phone;
        if (prop.emoji)                      return prop.emoji;
        if (prop.date)                       return this.formatDate(String(prop.date));
        if (prop.select)                     return prop.select.name;
        if (prop.multi_select?.length)       return prop.multi_select.map((s) => s.name);
        return undefined;
    }
  }

  // ── Content extraction ───────────────────────────────────────────────────────

  /**
   * Clean the raw API markdown body.
   *
   * Transformations:
   * 1. Normalise CRLF → LF
   * 2. Strip Anytype block-divider artifacts (space-padded `---` variants)
   * 3. Decode HTML entities via `html.ts`
   * 4. Strip trailing whitespace per line
   * 5. Collapse 3+ consecutive blank lines to 2
   * 6. Inject a Dataview query stub for empty Set/Collection objects when
   *    `config.dataviewQueries` is true (Obsidian-only, opt-in)
   */
  extractContent(obj: FullObject): string {
    let content = obj.markdown ?? obj.description ?? obj.snippet ?? "";

    content = content.replace(/\r\n/g, "\n");

    content = content
      .replace(/^[ \t]*---[ \t]*\n/, "")
      .replace(/\n +(---+)[ \t]*$/m, "")
      .replace(/\n +(---+)[ \t]*\n+$/m, "");

    content = decodeHtmlEntities(content);
    content = content.replace(/[ \t]+$/gm, "");
    content = content.replace(/\n{3,}/g, "\n\n").trim();

    // Inject a Dataview query stub for empty Set / Collection objects.
    // These are Anytype's dynamic query views — their body is always blank in
    // the API response because the content is computed at render time in the app.
    // WARN: Only emitted when config.dataviewQueries is true (default: false).
    //       Dataview queries are Obsidian-specific — other editors show them as plain code blocks.
    if (
      this.config.dataviewQueries &&
      !content &&
      (obj.layout === "set" || obj.layout === "collection")
    ) {
      const typeName = obj.type?.name ?? "";
      const fromClause =
        typeName && typeName !== "Query" && typeName !== "Set"
          ? `WHERE anytype-type = "${typeName}"`
          : "WHERE file.name != this.file.name";
      content = [
        "```dataview",
        `TABLE anytype-note-status, anytype-zettelkasten-type, created`,
        fromClause,
        "SORT created DESC",
        "```",
        "",
        "> **Note:** This is a Dataview approximation of an Anytype Set.",
        "> Edit the query above to match the filters used in Anytype.",
        "> Requires the [Dataview plugin](https://blacksmithgu.github.io/obsidian-dataview/) in Obsidian.",
        "> In Logseq and other editors this block renders as plain text.",
      ].join("\n");
    }

    return content;
  }

  // ── Rendering ────────────────────────────────────────────────────────────────

  /**
   * Serialise a `Record` to a YAML frontmatter block.
   * Returns `""` for empty records (content-only objects like plain notes).
   */
  renderFrontmatter(fm: Record<string, unknown>): string {
    if (Object.keys(fm).length === 0) return "";
    const yaml = YAML.stringify(fm, null, 2).trim();
    return `---\n${yaml}\n---\n`;
  }

  /**
   * Combine frontmatter and content into the final `.md` file string.
   * A blank line is inserted between frontmatter and content for readability.
   */
  assemble(fm: Record<string, unknown>, content: string): string {
    const parts: string[] = [];
    const fmStr = this.renderFrontmatter(fm);
    if (fmStr)    parts.push(fmStr);
    if (content)  parts.push(content);
    return parts.join("\n");
  }

  // ── Date helpers ─────────────────────────────────────────────────────────────

  private getCreated(obj: FullObject): string {
    const v = obj.created_date;
    if (!v) return "";
    return typeof v === "number" ? new Date(v * 1000).toISOString() : String(v);
  }

  /**
   * Returns the last-modified ISO string for an object.
   *
   * Returns `""` (not the current time) when the field is absent — returning
   * "now" as a fallback would cause a cache miss on every run for objects the
   * API never provides a modification date for.
   */
  private getLastModified(obj: FullObject): string {
    const v = obj.last_modified_date;
    if (!v) return "";
    return typeof v === "number" ? new Date(v * 1000).toISOString() : String(v);
  }

  /** Convert an ISO string to the configured output date format. */
  private formatDate(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    switch (this.config.dateFormat as DateFormat) {
      case "locale":    return d.toLocaleDateString();
      case "timestamp": return String(Math.floor(d.getTime() / 1000));
      default:          return d.toISOString();
    }
  }
}
