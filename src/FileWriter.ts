/**
 * All filesystem operations for the export output.
 *
 * Handles directory setup, markdown writing, file downloads, deletions, and
 * index generation. Dry-run mode logs all operations without executing them.
 *
 * @module
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportConfig } from './types.ts';
import { Logger } from './logger.ts';

/** Handles all file I/O for a single export run. */
export class FileWriter {
  private readonly config:  ExportConfig;
  private readonly logger:  Logger;
  private writtenCount = 0;
  private skippedCount = 0;

  constructor(config: ExportConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger ?? new Logger();
  }

  /**
   * Create the output directory and the files subdirectory.
   * Called once at the start of each export run. Safe to call on existing directories.
   */
  async ensureOutputDir(): Promise<void> {
    await mkdir(this.config.outputDir, { recursive: true });
    if (this.config.includeFiles) {
      await mkdir(join(this.config.outputDir, this.config.filesDir), { recursive: true });
    }
    this.logger.debug(`Output directory ready: ${this.config.outputDir}`);
  }

  /**
   * Write a single `.md` file for an exported object.
   *
   * Output path depends on `groupByType`:
   * - `false` → `<outputDir>/<slug>.md`
   * - `true` → `<outputDir>/types/<SafeType>/<slug>.md`
   *
   * In dry-run mode: logs the path and returns it without writing.
   */
  async writeMarkdown(slug: string, content: string, typeName?: string): Promise<string> {
    const filePath = this.resolveMarkdownPath(slug, typeName);

    if (this.config.dryRun) {
      this.logger.debug(`[DRY RUN] Would write: ${filePath}`);
      this.writtenCount++;
      return filePath;
    }

    await Bun.write(filePath, content);
    this.writtenCount++;
    this.logger.debug(`Wrote: ${filePath}`);
    return filePath;
  }

  /** Compute the output path for a slug. Type names are sanitised for filesystem safety. */
  private resolveMarkdownPath(slug: string, typeName?: string): string {
    const filename = `${slug}.md`;
    if (this.config.groupByType && typeName) {
      const safeType = typeName.replace(/[^a-zA-Z0-9_-]/g, '_');
      return join(this.config.outputDir, 'types', safeType, filename);
    }
    return join(this.config.outputDir, filename);
  }

  /**
   * Fetch a file from a list of candidate URLs and write it to disk.
   *
   * Tries each URL in order; the first successful response wins. HTTP 404s
   * on non-final URLs are silently skipped. Extension is detected from
   * `Content-Type`, then URL path, then falls back to `.bin`.
   *
   * Returns a relative path like `files/<cid>.png` suitable for markdown links,
   * or `null` when all URLs fail or the file exceeds `maxFileSizeMb`.
   */
  async downloadFile(
    urls:     string | string[],
    filename: string,
    apiKey:   string
  ): Promise<string | null> {
    const urlList = Array.isArray(urls) ? urls : [urls];

    if (this.config.dryRun) {
      const ext       = this.extensionFromUrl(urlList[0]) ?? '.bin';
      const finalName = filename + ext;
      this.logger.debug(`[DRY RUN] Would download: ${finalName}`);
      return join(this.config.filesDir, finalName);
    }

    let lastError: Error | null = null;

    for (const url of urlList) {
      try {
        const timeoutMs = Math.min(this.config.timeout ?? 30_000, 120_000);
        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal:  AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          if (res.status === 404 && urlList.length > 1) {
            this.logger.debug(`404 at ${url}, trying next…`);
            continue;
          }
          this.logger.warn(`Failed to download ${filename} from ${url}: HTTP ${res.status}`);
          lastError = new Error(`HTTP ${res.status}`);
          continue;
        }

        const maxBytes      = this.config.maxFileSizeMb * 1024 * 1024;
        const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);
        if (contentLength > 0 && contentLength > maxBytes) {
          this.logger.warn(`File too large (${Math.round(contentLength / 1024 / 1024)}MB > ${this.config.maxFileSizeMb}MB): ${filename}`);
          return null;
        }

        let extension = '.bin';
        const contentType = res.headers.get('content-type')?.split(';')[0];
        if (contentType) {
          extension = this.extensionFromMime(contentType) ?? extension;
        } else {
          extension = this.extensionFromUrl(url) ?? extension;
        }

        const finalName = filename + extension;
        const destPath  = join(this.config.outputDir, this.config.filesDir, finalName);

        if (await Bun.file(destPath).exists()) {
          this.logger.debug(`Already exists, skipping: ${finalName}`);
          this.skippedCount++;
          return join(this.config.filesDir, finalName);
        }

        const buffer = await res.arrayBuffer();
        if (buffer.byteLength > maxBytes) {
          this.logger.warn(`File too large after download (${Math.round(buffer.byteLength / 1024 / 1024)}MB > ${this.config.maxFileSizeMb}MB): ${filename}`);
          return null;
        }

        await Bun.write(destPath, buffer);
        this.logger.debug(`Downloaded: ${finalName}`);
        return join(this.config.filesDir, finalName);

      } catch (err) {
        this.logger.debug(`Download failed for ${filename} at ${url}: ${err}`);
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    this.logger.warn(`Download failed for ${filename} after ${urlList.length} attempt(s): ${lastError?.message}`);
    return null;
  }

  /** Map a `Content-Type` value to a file extension. Returns `null` for unrecognised types. */
  private extensionFromMime(mime: string): string | null {
    const map: Record<string, string> = {
      'image/jpeg':       '.jpg',
      'image/jpg':        '.jpg',
      'image/png':        '.png',
      'image/gif':        '.gif',
      'image/webp':       '.webp',
      'image/svg+xml':    '.svg',
      'application/pdf':  '.pdf',
      'application/zip':  '.zip',
      'text/plain':       '.txt',
      'text/markdown':    '.md',
      'application/json': '.json',
    };
    return map[mime.toLowerCase()] ?? null;
  }

  /**
   * Extract the file extension from a URL's path.
   * Returns `null` when no extension is found or it is suspiciously long (> 10 chars).
   */
  private extensionFromUrl(urlStr: string): string | null {
    try {
      const path = new URL(urlStr).pathname;
      if (!path.includes('.')) return null;
      const ext = path.slice(path.lastIndexOf('.'));
      return ext.length <= 10 ? ext : null;
    } catch {
      return null;
    }
  }

  /**
   * Remove the `.md` file for an object deleted in Anytype.
   * No-op when the file does not exist.
   */
  async deleteMarkdown(slug: string, typeName?: string): Promise<void> {
    const filePath = this.resolveMarkdownPath(slug, typeName);
    const file = Bun.file(filePath);
    if (!(await file.exists())) return;
    if (this.config.dryRun) {
      this.logger.debug(`[DRY RUN] Would delete: ${filePath}`);
      return;
    }
    await file.delete();
    this.logger.debug(`Deleted: ${filePath}`);
  }

  /**
   * Generate `index.md` listing all exported objects grouped and sorted by type.
   * Links use `[[slug|name]]` syntax for readable display in Obsidian.
   */
  async writeIndex(
    spaceName: string,
    objects:   Array<{ slug: string; name: string; type: string; created?: string }>
  ): Promise<void> {
    const exportDate = new Date().toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    const lines: string[] = [
      `# ${spaceName}`,
      '',
      `> Exported from Anytype on ${exportDate}`,
      '',
      `**${objects.length} objects**`,
      '',
    ];

    const byType: Record<string, typeof objects> = {};
    for (const obj of objects) {
      (byType[obj.type] ??= []).push(obj);
    }

    for (const [type, objs] of Object.entries(byType).sort()) {
      lines.push(`## ${type} (${objs.length})`);
      lines.push('');
      for (const obj of objs.sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`- [[${obj.slug}|${obj.name}]]`);
      }
      lines.push('');
    }

    await this.writeMarkdown('index', lines.join('\n'));
  }

  /** Snapshot of write/skip counts for the current run. */
  get stats() {
    return { written: this.writtenCount, skipped: this.skippedCount };
  }
}
