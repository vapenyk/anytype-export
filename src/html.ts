/**
 * Shared HTML entity decoding utility.
 *
 * Anytype's markdown renderer occasionally leaks HTML entities into its output.
 * Single canonical implementation used by both `Exporter` and `LinkTransformer`
 * to avoid duplicating the replacement chain.
 *
 * @module
 */

/**
 * Replace the HTML entities Anytype leaks into markdown with their literal characters.
 *
 * Covers the full set observed in real Anytype exports: `&#39;`, `&amp;`, `&lt;`,
 * `&gt;`, `&quot;`, `&nbsp;`, and `\_` (a rendering artifact, not a true entity).
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#39;/g,  "'")
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\\_/g,    '_');   // unescape \_ added by Anytype in link text
}
