/**
 * Orchestrates the full Anytype → Obsidian export pipeline.
 *
 * Steps: setup → fetch objects → build slug map → download files →
 * export markdown → remove deletions → write index → flush cache.
 *
 * @module
 */

import type { ExportConfig, FullObject, SlugMap } from './types.ts';
import { AnytypeClient } from './AnytypeClient.ts';
import { CacheManager } from './CacheManager.ts';
import { Exporter } from './Exporter.ts';
import { LinkTransformer } from './LinkTransformer.ts';
import { FileWriter } from './FileWriter.ts';
import { Logger, c } from './logger.ts';

// Matches both daemon (31009) and gateway (47800) local image/file URLs embedded
// in markdown. Declared at module level — not inside run() — to avoid recompilation
// on every call and ensure it's shared across both uses in steps 4 and 5.
const LOCAL_FILE_RE = /https?:\/\/127\.0\.0\.1(?::\d+)?\/(?:image|file)\/([a-zA-Z0-9_.-]+)/g;

/** Summary returned by `ExportPipeline.run()`. */
export interface PipelineResult {
  total:      number;  // objects considered after filtering
  exported:   number;  // objects written to disk this run
  skipped:    number;  // objects unchanged since last run (cache hit)
  deleted:    number;  // stale .md files removed
  errors:     number;  // objects that failed to export
  durationMs: number;  // wall-clock time for the whole run
}

/** Runs a complete Anytype → Obsidian export. Call `run()` once per sync. */
export class ExportPipeline {
  private readonly config:      ExportConfig;
  private readonly logger:      Logger;
  private readonly client:      AnytypeClient;
  private readonly exporter:    Exporter;
  private readonly fileWriter:  FileWriter;
  private cache!:               CacheManager; // initialised in run()

  constructor(config: ExportConfig, logger?: Logger) {
    this.config     = config;
    this.logger     = logger ?? new Logger(config.logLevel, config.quiet);
    this.client     = new AnytypeClient({
      apiKey:     config.apiKey,
      baseUrl:    config.baseUrl,
      apiVersion: config.apiVersion,
      maxRetries: config.maxRetries,
      retryDelay: config.retryDelay,
      timeout:    config.timeout,
      logger:     this.logger,
    });
    this.exporter   = new Exporter(config, this.logger);
    this.fileWriter = new FileWriter(config, this.logger);
  }

  /** Execute all pipeline steps and return a result summary. */
  async run(): Promise<PipelineResult> {
    const start  = Date.now();
    const result: PipelineResult = {
      total: 0, exported: 0, skipped: 0, deleted: 0, errors: 0, durationMs: 0,
    };

    // 1. Setup
    await this.fileWriter.ensureOutputDir();

    this.cache = new CacheManager(this.config.outputDir, this.config.spaceId, this.logger);
    if (!this.config.skipCache && !this.config.force) {
      await this.cache.load();
    }

    // 2. Fetch
    const gatewayUrl = (this.config.gatewayUrl ?? 'http://127.0.0.1:47800').replace(/\/$/, '');

    this.logger.info(c.cyan('📦 Fetching objects…'));
    // includeTypes is forwarded to the API for server-side pre-filtering.
    // Client-side type and exclude filters are applied below for exact matching.
    let summaries = await this.client.getObjects(
      this.config.spaceId,
      this.config.includeTypes,
    );

    if (this.config.skipArchived) {
      summaries = summaries.filter(o => !o.archived);
    }

    summaries = summaries.filter(o => o.name || o.snippet);

    if (this.config.includeTypes.length > 0) {
      const inc = new Set(this.config.includeTypes.map(t => t.toLowerCase()));
      summaries = summaries.filter(o => inc.has((o.type?.name ?? '').toLowerCase()));
    }

    if (this.config.excludeTypes.length > 0) {
      const exc = new Set(this.config.excludeTypes.map(t => t.toLowerCase()));
      summaries = summaries.filter(o => !exc.has((o.type?.name ?? '').toLowerCase()));
    }

    this.logger.info(`   → ${summaries.length} objects found — fetching full content…`);

    let fullObjects = await this.client.getObjectsBatched(
      this.config.spaceId,
      summaries,
      this.config.batchSize,
      this.config.rateLimitDelay,
      (done, total) => this.logger.progress(done, total, 'fetching objects')
    );

    if (this.config.skipEmpty) {
      const before = fullObjects.length;
      fullObjects  = fullObjects.filter(
        o => (o.markdown || o.snippet || o.description || '').trim()
      );
      this.logger.info(`   → Skipped ${before - fullObjects.length} empty objects`);
    }

    result.total = fullObjects.length;

    // 3. Slug map
    this.logger.info('🔗 Building slug map…');
    const slugMap: SlugMap = LinkTransformer.buildSlugMap(
      fullObjects,
      (name, id, used) => this.exporter.generateSlug(name, id, used)
    );

    for (const [id, entry] of Object.entries(this.cache.getAll())) {
      if (!slugMap[id]) {
        slugMap[id] = { slug: entry.slug, name: entry.slug, type: 'Unknown' };
      }
    }

    const linkTransformer = new LinkTransformer({
      slugMap,
      brokenLinkStyle: this.config.brokenLinkStyle,
      aliasLinks:      this.config.aliasLinks,
      detectEmbeds:    this.config.detectEmbeds,
      embedStyle:      this.config.embedStyle,
      logger:          this.logger,
    });

    // 4. File downloads
    const downloadedFiles = new Map<string, string>();

    if (this.config.includeFiles) {
      const cidToUrls = (cid: string): string[] => [
        `${this.config.baseUrl}/image/${cid}`,
        `${this.config.baseUrl}/file/${cid}`,
      ];

      const resolveFileValue = (value: string): { key: string; urls: string[] } => {
        if (value.startsWith('http://') || value.startsWith('https://')) {
          const cidMatch   = value.match(/\/(?:image|file)\/([a-zA-Z0-9_.-]+)$/);
          const daemonUrls = cidMatch?.[1] ? cidToUrls(cidMatch[1]) : [];
          return { key: value, urls: [value, ...daemonUrls] };
        }
        return { key: value, urls: cidToUrls(value) };
      };

      const toDownload = new Map<string, string[]>();

      for (const obj of fullObjects) {
        // (a) scan markdown body
        const body = obj.markdown ?? '';
        for (const m of body.matchAll(new RegExp(LOCAL_FILE_RE.source, LOCAL_FILE_RE.flags))) {
          const fullUrl = m[0];
          if (!toDownload.has(fullUrl)) {
            toDownload.set(fullUrl, [fullUrl, ...cidToUrls(m[1])]);
          }
        }

        // (b) file-format properties
        for (const prop of obj.properties ?? []) {
          if (prop.format === 'files' && prop.files?.length) {
            for (const cid of prop.files) {
              if (!toDownload.has(cid)) toDownload.set(cid, cidToUrls(cid));
            }
          }
        }

        // (c) file icon
        if (obj.icon?.format === 'file' && obj.icon.file) {
          const { key, urls } = resolveFileValue(obj.icon.file);
          if (!toDownload.has(key)) toDownload.set(key, urls);
        }

        // (d) cover image
        if (obj.cover) {
          const { key, urls } = resolveFileValue(obj.cover);
          if (!toDownload.has(key)) toDownload.set(key, urls);
        }
      }

      if (toDownload.size > 0) {
        this.logger.info(`📎 Downloading ${toDownload.size} file(s)…`);
        let done = 0;
        for (const [key, urls] of toDownload) {
          const filename  = key.startsWith('http') ? key.split('/').pop()!.replace(/\.[a-z0-9]{2,5}$/i, '') : key;
          const localPath = await this.fileWriter.downloadFile(urls, filename, this.config.apiKey);
          if (localPath) downloadedFiles.set(key, localPath);
          done++;
          this.logger.progress(done, toDownload.size, 'downloading files');
        }
      }
    }

    // 5. Export objects
    this.logger.info('✍️  Exporting objects…');
    const currentIds = new Set(fullObjects.map(o => o.id));
    const indexEntries: Array<{ slug: string; name: string; type: string }> = [];

    let i = 0;
    for (const obj of fullObjects) {
      i++;

      // Unicode-safe truncation using spread to split by code points
      const rawLabel = obj.name ?? obj.snippet ?? obj.id;
      const label    = [...rawLabel].slice(0, 35).join('');
      this.logger.progress(i, fullObjects.length, label);

      const slugEntry = slugMap[obj.id];
      if (!slugEntry) continue;

      const slug = slugEntry.slug;

      const rawDate      = obj.last_modified_date;
      const lastModified = rawDate
        ? (typeof rawDate === 'number' ? new Date(rawDate * 1000).toISOString() : String(rawDate))
        : '';

      const rawContent = this.exporter.extractContent(obj);
      const hash       = CacheManager.hash(rawContent);

      if (!this.config.force && !this.config.skipCache) {
        if (this.cache.isUnchanged(obj.id, lastModified, hash)) {
          result.skipped++;
          indexEntries.push({ slug, name: obj.name ?? 'Untitled', type: obj.type?.name ?? 'Object' });
          continue;
        }
      }

      try {
        const fm = this.exporter.buildFrontmatter(obj);

        let transformedContent = rawContent;
        const linkStats = { transformed: 0, broken: 0, skipped: 0 };
        if (this.config.transformLinks) {
          const xform    = linkTransformer.transform(rawContent);
          transformedContent = xform.result;
          Object.assign(linkStats, xform.stats);
        }

        // Rewrite embedded local image/file URLs → relative paths
        if (this.config.includeFiles && downloadedFiles.size > 0) {
          transformedContent = transformedContent.replace(
            new RegExp(LOCAL_FILE_RE.source, LOCAL_FILE_RE.flags),
            (fullUrl) => downloadedFiles.get(fullUrl) ?? fullUrl
          );
        }

        if (linkStats.broken > 0) {
          this.logger.debug(`  ${obj.name}: ${linkStats.broken} broken link(s)`);
        }

        const markdown = this.exporter.assemble(fm, transformedContent);
        await this.fileWriter.writeMarkdown(slug, markdown, obj.type?.name);

        this.cache.update(obj.id, { slug, lastModified, contentHash: hash, typeName: obj.type?.name });

        result.exported++;
        indexEntries.push({ slug, name: obj.name ?? 'Untitled', type: obj.type?.name ?? 'Object' });

      } catch (err) {
        this.logger.error(`Failed to export "${obj.name ?? obj.id}": ${err}`);
        result.errors++;
      }
    }

    // 6. Deletions
    const deletedIds = this.cache.getDeletedIds(currentIds);
    if (deletedIds.length > 0) {
      this.logger.info(`🗑️  Removing ${deletedIds.length} deleted objects…`);
      for (const id of deletedIds) {
        const entry = this.cache.getAll()[id];
        if (entry) {
          await this.fileWriter.deleteMarkdown(entry.slug, entry.typeName);
          this.cache.remove(id);
          result.deleted++;
        }
      }
    }

    // 7. Index
    // Uses the human-readable space name from config (set at login time).
    if (this.config.createIndex) {
      const indexTitle = this.config.spaceName || this.config.spaceId || 'Anytype';
      await this.fileWriter.writeIndex(indexTitle, indexEntries);
    }

    // 8. Cache
    if (!this.config.skipCache) {
      await this.cache.save();
    }

    result.durationMs = Date.now() - start;
    return result;
  }
}
