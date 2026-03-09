/**
 * Credential storage via the OS keychain.
 *
 * Persists Anytype credentials (API key, space ID) in the operating system's
 * native credential store — Keychain on macOS, libsecret on Linux, Credential
 * Manager on Windows. Credentials are encrypted at rest by the OS.
 *
 * @module
 */

import { secrets } from 'bun';

// Namespace for all keychain entries created by this app.
const SERVICE = 'anytype-export';

// A single entry stores the full credentials JSON blob, keeping saves atomic.
const CREDS_KEY = 'credentials';

/**
 * The complete set of values persisted after a successful login.
 * All four fields are required; a partial entry is treated as corrupt.
 */
export interface SavedCredentials {
  apiKey:     string;
  spaceId:    string;
  spaceName:  string;
  gatewayUrl: string;
}

/** Reads, writes, and clears Anytype credentials from the OS keychain. */
export class CredentialStore {
  /**
   * Retrieve credentials from the OS keychain.
   * Returns `null` on first run or if the entry cannot be parsed. Never throws.
   */
  async load(): Promise<SavedCredentials | null> {
    try {
      const raw = await secrets.get({ service: SERVICE, name: CREDS_KEY });
      if (!raw) return null;
      return JSON.parse(raw) as SavedCredentials;
    } catch {
      return null;
    }
  }

  /**
   * Write credentials to the OS keychain as a single atomic JSON blob.
   * An existing entry for the same service/name pair is replaced.
   */
  async save(creds: SavedCredentials): Promise<void> {
    await secrets.set({
      service: SERVICE,
      name:    CREDS_KEY,
      value:   JSON.stringify(creds),
    });
  }

  /**
   * Remove credentials from the OS keychain.
   * No-op when no entry exists. Never throws.
   */
  async clear(): Promise<void> {
    try {
      await secrets.delete({ service: SERVICE, name: CREDS_KEY });
    } catch {
      // Ignore — the intent is "log me out"
    }
  }

  /** Human-readable storage backend label, shown in `anytype-export status`. */
  get storageKind(): string {
    return 'OS keychain (Bun.secrets)';
  }

  /** Always `null` — credentials live in the keychain, not on disk. */
  get credentialsPath(): string | null {
    return null;
  }
}

/** Singleton shared across all CLI commands. */
export const credStore = new CredentialStore();
