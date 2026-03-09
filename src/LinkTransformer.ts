/**
 * Converts `anytype://` links to Obsidian `[[wikilinks]]`.
 *
 * Scans markdown content for all forms of Anytype object references and
 * replaces them using a pre-built slug map. Content inside fenced code blocks
 * and inline code spans is never modified.
 *
 * Supported input forms:
 * - `![alt](anytype://object?objectId=ID)` — embed
 * - `[text](anytype://object?objectId=ID)` — named link
 * - `anytype://object?objectId=ID` — bare query URL
 * - `anytype://object/ID` — bare path URL
 *
 * IMPORTANT: This file uses plain regex literals throughout. Do NOT replace
 * them with magic-regexp — `charNotIn(']')` generates `[^]]` which JavaScript
 * parses as `[^]` (any char) followed by a literal `]`, silently breaking all
 * link matching.
 *
 * @module
 */

import type { SlugMap, BrokenLinkStyle, EmbedStyle } from "./types.ts";
import { decodeHtmlEntities } from "./html.ts";
import { Logger } from "./logger.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TransformOptions {
  slugMap: SlugMap;
  brokenLinkStyle?: BrokenLinkStyle; // default: "keep"
  aliasLinks?: boolean;              // default: true
  detectEmbeds?: boolean;            // default: true
  embedStyle?: EmbedStyle;           // default: "wikilink"
  logger?: Logger;
}

interface TransformStats {
  transformed: number; // links successfully resolved via slugMap
  broken: number;      // links whose objectId was not found in slugMap
  skipped: number;     // reserved for future use
}

// ── Regex patterns ────────────────────────────────────────────────────────────

const ID       = "[a-zA-Z0-9_.-]+";
const AFTER_ID = "(?:&[^)#\\s]*)?"; // optional &key=val… before ) or #
const ANCHOR   = "(?:#([^)\\s]+))?"; // optional #anchor captured in group
const PREFIX   = "(?:anytype://object\\?objectId=|anytype://object/)";

const RE = {
  fencedCode:  /```[\s\S]*?```/g,
  inlineCode:  /`[^`]+`/g,
  placeholder: /\x00CODE(\d+)\x00/g,

  embedMarkdown: new RegExp(
    `!\\[([^\\]]*)\\]\\(${PREFIX}(${ID})${AFTER_ID}${ANCHOR}\\)`, "g",
  ),

  namedMarkdown: new RegExp(
    `(?<!!)\\[([^\\]]+)\\]\\(${PREFIX}(${ID})${AFTER_ID}${ANCHOR}\\)`, "g",
  ),

  bareQuery: new RegExp(
    `(?<!\\()anytype://object\\?objectId=(${ID})${AFTER_ID}`, "g",
  ),

  barePath: new RegExp(`(?<!\\()anytype://object/(${ID})`, "g"),
};

// ── LinkTransformer ───────────────────────────────────────────────────────────

/** Transforms `anytype://` links in markdown to Obsidian `[[wikilinks]]`. */
export class LinkTransformer {
  private readonly slugMap:         SlugMap;
  private readonly brokenLinkStyle: BrokenLinkStyle;
  private readonly aliasLinks:      boolean;
  private readonly detectEmbeds:    boolean;
  private readonly embedStyle:      EmbedStyle;
  private readonly logger:          Logger;

  constructor(opts: TransformOptions) {
    this.slugMap         = opts.slugMap;
    this.brokenLinkStyle = opts.brokenLinkStyle ?? "keep";
    this.aliasLinks      = opts.aliasLinks ?? true;
    this.detectEmbeds    = opts.detectEmbeds ?? true;
    this.embedStyle      = opts.embedStyle ?? "wikilink";
    this.logger          = opts.logger ?? new Logger();
  }

  /**
   * Scan and replace all `anytype://` references in a markdown string.
   *
   * Processing order: embeds before named links (both match `[`, embed has
   * a leading `!` that disambiguates). Fenced/inline code is protected first.
   */
  transform(content: string): { result: string; stats: TransformStats } {
    const stats: TransformStats = { transformed: 0, broken: 0, skipped: 0 };

    // Step 1: Protect code blocks with null-byte placeholders
    const codeBlocks: string[] = [];
    const protect = (match: string): string => {
      codeBlocks.push(match);
      return `\x00CODE${codeBlocks.length - 1}\x00`;
    };

    let s = content
      .replace(RE.fencedCode, protect)
      .replace(RE.inlineCode, protect);

    // Step 2: Embeds — ![alt](anytype://…) → ![[slug]]
    if (this.detectEmbeds) {
      s = s.replace(RE.embedMarkdown, (_match, _alt, id, anchor) => {
        const entry = this.slugMap[id];
        if (!entry) { stats.broken++; return this.handleBroken(id, undefined, true); }
        stats.transformed++;
        return this.formatEmbed(entry.slug, anchor);
      });
    }

    // Step 3: Named links — [text](anytype://…) → [[slug]] or [[slug|alias]]
    s = s.replace(RE.namedMarkdown, (_match, text, id, anchor) => {
      const entry = this.slugMap[id];
      const clean = decodeHtmlEntities(text);
      if (!entry) { stats.broken++; return this.handleBroken(id, clean, false); }
      stats.transformed++;
      const a = anchor ? `#${decodeURIComponent(anchor)}` : "";
      if (this.aliasLinks && clean && clean !== entry.name && clean !== entry.slug) {
        return `[[${entry.slug}${a}|${clean}]]`;
      }
      return `[[${entry.slug}${a}]]`;
    });

    // Step 4: Bare query — anytype://object?objectId=ID → [[slug]]
    s = s.replace(RE.bareQuery, (_match, id) => {
      const entry = this.slugMap[id];
      if (!entry) { stats.broken++; return this.handleBroken(id, undefined, false); }
      stats.transformed++;
      return `[[${entry.slug}]]`;
    });

    // Step 5: Bare path — anytype://object/ID → [[slug]]
    s = s.replace(RE.barePath, (_match, id) => {
      const entry = this.slugMap[id];
      if (!entry) { stats.broken++; return this.handleBroken(id, undefined, false); }
      stats.transformed++;
      return `[[${entry.slug}]]`;
    });

    // Step 6: Restore code blocks
    const result = s.replace(RE.placeholder, (_, idx) => codeBlocks[parseInt(idx)]);
    return { result, stats };
  }

  /** Render a resolved embed in the configured style. */
  private formatEmbed(slug: string, anchor?: string): string {
    const a = anchor ? `#${decodeURIComponent(anchor)}` : "";
    switch (this.embedStyle) {
      case "markdown": return `![](${slug}${a})`;
      case "html":     return `<iframe src="${slug}${a}"></iframe>`;
      default:         return `![[${slug}${a}]]`;
    }
  }

  /** Render a link whose objectId was not found in the slug map. */
  private handleBroken(id: string, text?: string, isEmbed?: boolean): string {
    switch (this.brokenLinkStyle) {
      case "remove": return text ?? "";
      case "warn":   return `${isEmbed ? "!" : ""}[[missing:${id.slice(0, 12)}]]`;
      default:       // "keep"
        if (text) return `[${text}](${id})`;
        return isEmbed ? `![[${id}]]` : `[[${id}]]`;
    }
  }

  /** Build the `objectId → SlugMapEntry` lookup table for a list of objects. */
  static buildSlugMap(
    objects: Array<{
      id: string;
      name?: string;
      snippet?: string;
      type?: { name?: string };
    }>,
    generateSlug: (name: string, id: string, used: Set<string>) => string,
  ): SlugMap {
    const map: SlugMap = {};
    const used: Set<string> = new Set();
    for (const obj of objects) {
      const name = obj.name || obj.snippet || "Untitled";
      const slug = generateSlug(name, obj.id, used);
      map[obj.id] = { slug, name, type: obj.type?.name ?? "Object" };
      used.add(slug);
    }
    return map;
  }
}
