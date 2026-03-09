/**
 * Structured console output with ANSI colours.
 *
 * No external dependencies.
 *
 * @module
 */

/** Minimum log level for a `Logger` instance. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

/** ANSI colour helpers used in CLI output and logger prefixes. */
export const c = {
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,    // faint — timestamps, secondary info
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,   // commands, paths, highlights
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,   // success states
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,   // warnings, prompts
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,   // errors
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,    // emphasis
  blue:   (s: string) => `\x1b[34m${s}\x1b[0m`,   // debug prefix
};

/**
 * Levelled logger with timestamps and an in-place progress bar.
 *
 * `quiet` suppresses info/debug output; warn and error always print.
 */
export class Logger {
  private readonly minLevel: number;
  private readonly quiet:    boolean;

  constructor(level: LogLevel = 'info', quiet = false) {
    this.minLevel = LEVELS[level];
    this.quiet    = quiet;
  }

  private ts(): string {
    return c.dim(new Date().toISOString());
  }

  debug(msg: string, ...args: unknown[]): void {
    if (this.quiet || this.minLevel > LEVELS.debug) return;
    console.log(`${this.ts()} ${c.blue('DEBUG')} ${msg}`, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    if (this.quiet || this.minLevel > LEVELS.info) return;
    console.log(`${this.ts()} ${c.cyan(' INFO')} ${msg}`, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    // warn prints even when quiet=true; suppressed only by explicit level config
    if (this.minLevel > LEVELS.warn) return;
    console.warn(`${this.ts()} ${c.yellow(' WARN')} ${msg}`, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    // error is never suppressed — always goes to stderr
    console.error(`${this.ts()} ${c.red('ERROR')} ${msg}`, ...args);
  }

  success(msg: string): void {
    if (this.quiet) return;
    console.log(c.green(`✓ ${msg}`));
  }

  /**
   * In-place progress bar written to stdout via `\r`.
   * Renders: `[████████████░░░░░░░░] 60% label…`
   * Emits `\n` automatically when `current === total`.
   */
  progress(current: number, total: number, label = ''): void {
    if (this.quiet) return;
    const pct    = Math.round((current / total) * 100);
    const filled = Math.round(pct / 5);
    const bar    = '█'.repeat(filled) + '░'.repeat(20 - filled);
    process.stdout.write(`\r  [${bar}] ${pct}% ${label.padEnd(40)}`);
    if (current === total) process.stdout.write('\n');
  }
}
