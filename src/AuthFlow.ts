/**
 * PIN-based authentication with the Anytype daemon.
 *
 * Mirrors the Raycast extension's auth flow:
 * https://github.com/raycast/extensions/blob/main/extensions/anytype/src/tools/
 *
 * Flow: request challenge → user enters PIN from Anytype Settings → exchange for API key → pick space.
 *
 * @module
 */

import { c } from "./logger.ts";
import { DAEMON_URL, API_VERSION, APP_NAME } from "./AnytypeClient.ts";

// 4-digit PIN — plain regex.
// NOTE: Do NOT use magic-regexp here. charNotIn(']') generates [^]] which in
// JavaScript regex means [^] (any char) followed by literal ] — not a negated
// class. We use plain literals throughout this codebase to avoid that footgun.
const PIN_RE = /^\d{4}$/;

const PICK_MAX_ATTEMPTS = 10;
const PIN_TIMEOUT_MS = 120_000; // 2 minutes

// ── Types ─────────────────────────────────────────────────────────────────────

interface CreateChallengeRequest {
  app_name: string;
}
interface CreateChallengeResponse {
  challenge_id: string;
}

interface CreateApiKeyRequest {
  challenge_id: string;
  code: string;
}
interface CreateApiKeyResponse {
  api_key: string;
}

interface RawSpace {
  id: string;
  name?: string;
  icon?: { emoji?: string };
  gateway_url?: string;
}

/** Returned by `run()` and `pickSpace()`, and saved to the OS keychain. */
export interface AuthResult {
  apiKey: string;
  spaceId: string;
  spaceName: string;
  gatewayUrl: string;
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** Thrown when the daemon is unreachable (ECONNREFUSED — Anytype app not running). */
export class AnytypeNotRunningError extends Error {
  constructor() {
    super(
      `Anytype doesn't seem to be running.\n\n  → Open the Anytype desktop app and try again.`,
    );
    this.name = "AnytypeNotRunningError";
  }
}

// ── Low-level fetch ───────────────────────────────────────────────────────────

/**
 * Unified unauthenticated/authenticated request helper.
 * Pass `apiKey=null` for pre-auth endpoints (`/v1/auth/*`).
 * Throws `AnytypeNotRunningError` on ECONNREFUSED.
 */
async function apiRequest<Req, Res>(
  method: "GET" | "POST",
  path: string,
  apiKey: string | null,
  body?: Req,
): Promise<Res> {
  let res: Response;
  try {
    res = await fetch(`${DAEMON_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Anytype-Version": API_VERSION,
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") {
      throw new AnytypeNotRunningError();
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<Res>;
}

// ── Auth API calls ────────────────────────────────────────────────────────────

/** POST `/v1/auth/challenges` — obtain a challenge ID that the user must solve with their PIN. */
async function startChallenge(): Promise<string> {
  const res = await apiRequest<CreateChallengeRequest, CreateChallengeResponse>(
    "POST",
    "/v1/auth/challenges",
    null,
    { app_name: APP_NAME },
  );
  if (!res.challenge_id) throw new Error("No challenge_id in response");
  return res.challenge_id;
}

/** POST `/v1/auth/api_keys` — exchange a solved challenge (PIN) for a permanent API key. */
async function solveChallenge(
  challengeId: string,
  code: string,
): Promise<string> {
  const res = await apiRequest<CreateApiKeyRequest, CreateApiKeyResponse>(
    "POST",
    "/v1/auth/api_keys",
    null,
    { challenge_id: challengeId, code },
  );
  if (!res.api_key) throw new Error("No api_key in response");
  return res.api_key;
}

/** GET `/v1/spaces` — return the first page (up to 50) of spaces for a given API key. */
async function fetchSpaces(apiKey: string): Promise<RawSpace[]> {
  const res = await apiRequest<never, { data?: RawSpace[] }>(
    "GET",
    "/v1/spaces?limit=50&offset=0",
    apiKey,
  );
  return res.data ?? [];
}

// ── TTY helpers ───────────────────────────────────────────────────────────────

/** Synchronous stdin prompt — returns the raw input string. */
function ask(question: string): string {
  return prompt(question) ?? "";
}

/** Synchronous stdin prompt that exits the process if no input arrives within `timeoutMs`. */
function askWithTimeout(question: string, timeoutMs: number): string {
  const timer = setTimeout(() => {
    console.log(
      "\n\n  Timed out waiting for input. Please run the command again.",
    );
    process.exit(1);
  }, timeoutMs);
  const answer = prompt(question) ?? "";
  clearTimeout(timer);
  return answer;
}

/**
 * Prompts the user to pick a number from `1..count`.
 * Loops until valid input or `PICK_MAX_ATTEMPTS` exceeded.
 * Returns a zero-based index.
 */
function pickFromList(question: string, count: number): number {
  for (let attempt = 1; attempt <= PICK_MAX_ATTEMPTS; attempt++) {
    const raw = ask(question);
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= count) return n - 1;
    const remaining = PICK_MAX_ATTEMPTS - attempt;
    if (remaining > 0) {
      console.log(
        `  Please enter a number between 1 and ${count}. (${remaining} attempt(s) left)`,
      );
    }
  }
  throw new Error("Too many invalid inputs. Please run the command again.");
}

// ── AuthFlow ──────────────────────────────────────────────────────────────────

/** Handles the full PIN-challenge auth flow and space selection. */
export class AuthFlow {
  /**
   * Obtain an API key via PIN challenge, then pick a space.
   *
   * Retries the challenge up to 3 times on a wrong PIN.
   * A fresh challenge is requested after each wrong attempt — the old one
   * is invalidated by the daemon immediately.
   */
  async run(): Promise<AuthResult> {
    console.log("");
    console.log(c.bold("  🔐 Connecting to Anytype…\n"));

    let challengeId: string;
    try {
      challengeId = await startChallenge();
    } catch (err) {
      if (err instanceof AnytypeNotRunningError) throw err;
      throw new Error(`Could not start authentication: ${err}`);
    }

    console.log(`  ${c.cyan("1.")} Open ${c.bold("Anytype")} on your computer`);
    console.log(`  ${c.cyan("2.")} Go to ${c.bold("Settings → API")}`);
    console.log(
      `  ${c.cyan("3.")} Enter the ${c.bold("4-digit code")} shown there`,
    );
    console.log("");

    let apiKey: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const pin = askWithTimeout(`  ${c.yellow("→")} Code: `, PIN_TIMEOUT_MS);

      if (!PIN_RE.test(pin)) {
        console.log(`  ${c.red("✗")} Must be exactly 4 digits.\n`);
        continue;
      }

      try {
        apiKey = await solveChallenge(challengeId, pin);
        break;
      } catch (err) {
        const msg = String(err);
        const isWrong =
          msg.includes("401") ||
          msg.includes("403") ||
          msg.toLowerCase().includes("invalid") ||
          msg.toLowerCase().includes("wrong");
        if (isWrong) {
          console.log(
            `  ${c.red("✗")} Wrong code. ${3 - attempt} attempt(s) left.\n`,
          );
          try {
            challengeId = await startChallenge();
          } catch {
            /* keep old if refresh fails */
          }
        } else {
          throw err;
        }
      }
    }

    if (!apiKey)
      throw new Error("Too many incorrect attempts. Run login again.");

    console.log(`\n  ${c.green("✓")} Connected!\n`);
    return this.pickSpace(apiKey);
  }

  /**
   * List spaces and let the user pick one.
   *
   * Also called by `anytype-export switch` with an already-valid API key.
   * Auto-selects when the user only has one space.
   */
  async pickSpace(apiKey: string): Promise<AuthResult> {
    console.log(c.dim("  Fetching your spaces…"));
    const spaces = await fetchSpaces(apiKey);

    if (spaces.length === 0) {
      throw new Error("No spaces found. Create a space in Anytype first.");
    }

    let idx = 0;
    if (spaces.length === 1) {
      console.log(
        `  ${c.green("✓")} Space: ${c.bold(spaces[0].name ?? spaces[0].id)}\n`,
      );
    } else {
      console.log("");
      console.log(c.bold("  Your spaces:"));
      console.log("");
      spaces.forEach((s, i) => {
        const icon = s.icon?.emoji ?? "📦";
        console.log(
          `    ${c.cyan(String(i + 1) + ".")} ${icon}  ${s.name ?? s.id}`,
        );
      });
      console.log("");
      idx = await pickFromList(
        `  ${c.yellow("→")} Select space (1–${spaces.length}): `,
        spaces.length,
      );
      console.log(
        `  ${c.green("✓")} Selected: ${c.bold(spaces[idx].name ?? spaces[idx].id)}\n`,
      );
    }

    const space = spaces[idx];
    return {
      apiKey,
      spaceId: space.id,
      spaceName: space.name ?? space.id,
      gatewayUrl: space.gateway_url ?? "http://127.0.0.1:47800",
    };
  }
}
