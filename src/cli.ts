#!/usr/bin/env bun
/**
 * anytype-export command-line interface.
 *
 * Entry point. Parses argv, loads credentials, and dispatches to command handlers.
 * Commands: `login`, `export` (default), `switch`, `status`, `logout`.
 *
 * @packageDocumentation
 */

import { AnytypeConnectionError, AnytypeAuthError } from "./AnytypeClient.ts";
import { ExportPipeline } from "./ExportPipeline.ts";
import { Logger, c } from "./logger.ts";
import { AuthFlow, AnytypeNotRunningError } from "./AuthFlow.ts";
import type { ExportConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { credStore } from "./secrets.ts";

import pkg from "../package.json" with { type: "json" };
const APP_VERSION: string = pkg.version;

// ── Argument parsing ──────────────────────────────────────────────────────────

// Single-char flag aliases → long flag names.
// Only flags whose semantics are obvious from a single letter are included.
const SHORT_FLAGS: Record<string, string> = {
  h: "help",
  v: "version",
  o: "output",
};

/**
 * Robust CLI argument parser supporting three flag syntaxes:
 * - `--flag` → boolean `true`
 * - `--flag=value` → string value
 * - `--flag value` → string value (next arg must not start with `-`)
 * - `-h` / `-v` / `-o <val>` → expanded via `SHORT_FLAGS`
 */
function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  let command = "export";
  let commandFound = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=", 2);
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
      i++;
      continue;
    }

    if (arg.startsWith("-") && arg.length === 2) {
      const longKey = SHORT_FLAGS[arg[1]];
      if (longKey) {
        const next = argv[i + 1];
        const isBoolean = longKey === "help" || longKey === "version";
        if (!isBoolean && next && !next.startsWith("-")) {
          flags[longKey] = next;
          i++;
        } else {
          flags[longKey] = true;
        }
        i++;
        continue;
      }
    }

    if (!commandFound) {
      command = arg;
      commandFound = true;
    }
    i++;
  }

  return { command, flags };
}

const { command, flags } = parseArgs(process.argv.slice(2));

// ── UI helpers ────────────────────────────────────────────────────────────────

/** Print the branded anytype-export header to stdout. */
function banner(): void {
  console.log(`
${c.green("┌─────────────────────────────────────┐")}
${c.green("│")}  ${c.bold("🌿 anytype-export")}                  ${c.green("│")}
${c.green("│")}  ${c.dim("Export Anytype → Obsidian markdown")}  ${c.green("│")}
${c.green("└─────────────────────────────────────┘")}
`);
}

/** Print a user-friendly error message to stderr. Known error types are shown without a stack trace. */
function showError(err: unknown): void {
  const isKnown =
    err instanceof AnytypeConnectionError ||
    err instanceof AnytypeAuthError ||
    err instanceof AnytypeNotRunningError;
  const msg = isKnown ? (err as Error).message : String(err);
  console.error(`\n${c.red("✗")} ${msg}\n`);
}

/** Return the full `--help` text as a string (printed to stdout then process exits). */
function helpText(): string {
  return `
${c.bold("Usage:")}
  anytype-export ${c.dim("[command]")} ${c.dim("[options]")}

${c.bold("Commands:")}
  ${c.cyan("login")}              Connect your Anytype account (run once)
  ${c.cyan("export")}  ${c.dim("(default)")}  Export space to markdown files
  ${c.cyan("switch")}             Switch to a different space
  ${c.cyan("status")}             Show current account & space
  ${c.cyan("logout")}             Remove saved credentials

${c.bold("Export options:")}
  ${c.cyan("-o")}, ${c.cyan("--output")} ${c.dim("DIR")}  Where to save files ${c.dim("(default: ./export)")}
  ${c.cyan("--force")}            Re-export everything, ignore cache
  ${c.cyan("--dry-run")}          Preview without writing files
  ${c.cyan("--no-files")}         Skip image & attachment downloads
  ${c.cyan("--include-types")}    ${c.dim("Note,Task,...")}  Only export these types
  ${c.cyan("--exclude-types")}    ${c.dim("Task,...")}       Skip these types
  ${c.cyan("--group-by-type")}    Organize into subdirectories by type
  ${c.cyan("--create-index")}     Generate an index.md overview file
  ${c.cyan("--verbose")}          Debug-level logging
  ${c.cyan("--quiet")}            Suppress all output except errors

${c.bold("Global options:")}
  ${c.cyan("-h")}, ${c.cyan("--help")}       Show this help
  ${c.cyan("-v")}, ${c.cyan("--version")}    Print version

${c.bold("Examples:")}
  anytype-export login
  anytype-export
  anytype-export -o ~/notes
  anytype-export --output ~/notes
  anytype-export --include-types Note,Task --force
`;
}

// ── Command handlers ──────────────────────────────────────────────────────────

/** `anytype-export login` — run the PIN challenge flow and save credentials to the OS keychain. */
async function cmdLogin(): Promise<void> {
  banner();

  const existing = await credStore.load();
  if (existing && !flags["re-login"]) {
    console.log(
      `  ${c.yellow("⚠")}  Already logged in as space ${c.bold(existing.spaceName)}.`,
    );
    console.log(`     Run ${c.cyan("anytype-export switch")} to change space.`);
    console.log(
      `     Run ${c.cyan("anytype-export login --re-login")} to re-authenticate.\n`,
    );
    return;
  }

  try {
    const result = await new AuthFlow().run();
    await credStore.save(result);
    console.log(`\n  ${c.green("✅ Ready!")} Credentials saved.\n`);
    console.log(`  Now run: ${c.cyan("anytype-export")}\n`);
  } catch (err) {
    showError(err);
    process.exit(3);
  }
}

/** `anytype-export switch` — re-pick a space using the saved API key (no PIN required). */
async function cmdSwitch(): Promise<void> {
  banner();

  const creds = await credStore.load();
  if (!creds) {
    console.log(
      `  No account found. Run ${c.cyan("anytype-export login")} first.\n`,
    );
    process.exit(1);
  }

  try {
    const result = await new AuthFlow().pickSpace(creds.apiKey);
    await credStore.save(result);
    console.log(
      `\n  ${c.green("✓")} Switched to: ${c.bold(result.spaceName)}\n`,
    );
  } catch (err) {
    showError(err);
    process.exit(3);
  }
}

/** `anytype-export status` — print the currently active account, space, and credential storage details. */
async function cmdStatus(): Promise<void> {
  const creds = await credStore.load();
  if (!creds) {
    console.log(`\n  Not logged in. Run ${c.cyan("anytype-export login")}\n`);
    return;
  }
  console.log(`\n  ${c.green("✓")} Logged in`);
  console.log(`  Space:   ${c.bold(creds.spaceName)}`);
  console.log(`  Storage: ${c.dim(credStore.storageKind)}`);
  if (credStore.credentialsPath) {
    console.log(`  File:    ${c.dim(credStore.credentialsPath)}`);
  }
  console.log("");
}

/** `anytype-export logout` — delete all saved credentials from the OS keychain. */
async function cmdLogout(): Promise<void> {
  await credStore.clear();
  console.log(`\n  ${c.green("✓")} Logged out.\n`);
}

/**
 * Run the full export pipeline.
 *
 * Exit codes:
 * - `0` — success (even if some objects had errors — see `result.errors`)
 * - `1` — one or more objects failed to export
 * - `3` — fatal error (connection refused, auth failed)
 */
async function cmdExport(): Promise<void> {
  banner();

  const creds = await credStore.load();
  if (!creds) {
    console.log(`  ${c.yellow("⚠")}  Not logged in.\n`);
    console.log(`  Run ${c.cyan("anytype-export login")} first.\n`);
    process.exit(1);
  }

  const logLevel = flags["verbose"]
    ? "debug"
    : ((flags["quiet"] ? "error" : "info") as ExportConfig["logLevel"]);

  const config: ExportConfig = {
    ...DEFAULT_CONFIG,
    apiKey: creds.apiKey,
    spaceId: creds.spaceId,
    spaceName: creds.spaceName,
    gatewayUrl: creds.gatewayUrl,
    outputDir: flags["output"] ? String(flags["output"]) : "./export",
    force: !!flags["force"],
    dryRun: !!flags["dry-run"],
    skipCache: !!flags["skip-cache"],
    includeFiles: !flags["no-files"],
    createIndex: !!flags["create-index"],
    groupByType: !!flags["group-by-type"],
    logLevel,
    verbose: !!flags["verbose"],
    quiet: !!flags["quiet"],
    includeTypes: flags["include-types"]
      ? String(flags["include-types"])
          .split(",")
          .map((s) => s.trim())
      : [],
    excludeTypes: flags["exclude-types"]
      ? String(flags["exclude-types"])
          .split(",")
          .map((s) => s.trim())
      : [],
  };

  const logger = new Logger(config.logLevel, config.quiet);

  logger.info(c.bold(`Space:  ${c.cyan(creds.spaceName)}`));
  logger.info(`Output: ${c.cyan(config.outputDir)}`);
  if (config.dryRun)
    logger.info(c.yellow("  ⚡ DRY RUN — no files will be written"));
  if (config.force) logger.info(c.yellow("  ⚡ FORCE — full re-export"));
  console.log("");

  const pipeline = new ExportPipeline(config, logger);
  let result;
  try {
    result = await pipeline.run();
  } catch (err) {
    showError(err);
    if (
      err instanceof AnytypeConnectionError ||
      err instanceof AnytypeAuthError ||
      err instanceof AnytypeNotRunningError
    ) {
      process.exit(3);
    }
    throw err;
  }

  console.log("");
  console.log(c.green("═══════════════════════════════"));
  console.log(c.bold("  Done!"));
  console.log(c.green("═══════════════════════════════"));
  console.log(`  Exported : ${c.green(String(result.exported))}`);
  console.log(`  Skipped  : ${c.dim(String(result.skipped))} (unchanged)`);
  if (result.deleted > 0)
    console.log(`  Deleted  : ${c.yellow(String(result.deleted))}`);
  if (result.errors > 0)
    console.log(`  Errors   : ${c.red(String(result.errors))}`);
  console.log(
    `  Time     : ${c.dim((result.durationMs / 1000).toFixed(1) + "s")}`,
  );
  console.log(c.green("═══════════════════════════════"));
  console.log("");

  if (result.errors > 0) process.exit(1);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

if (flags.help || flags.h) {
  console.log(helpText());
  process.exit(0);
}
if (flags.version || flags.v) {
  console.log(APP_VERSION);
  process.exit(0);
}

switch (command) {
  case "login":
    await cmdLogin();
    break;
  case "switch":
    await cmdSwitch();
    break;
  case "status":
    await cmdStatus();
    break;
  case "logout":
    await cmdLogout();
    break;
  case "export":
    await cmdExport();
    break;
  default:
    if (!process.argv.slice(2).length) {
      await cmdExport();
      break;
    }
    console.log(helpText());
    process.exit(1);
}

process.exit(0);
