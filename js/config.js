/**
 * Goblet Frontend — Configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * Update WORKER_URL before deploying to production.
 * For local development with `wrangler dev`, use http://localhost:8787
 */

const config = {
  /**
   * The base URL of the Goblet Cloudflare Worker.
   * Update this to your deployed worker URL for production.
   * @example 'https://goblet-worker.yourname.workers.dev'
   */
  WORKER_URL: 'https://gob-goblet.pages.dev',

  /**
   * Maximum file size allowed for encryption (25 MB).
   */
  MAX_FILE_SIZE: 25 * 1024 * 1024,

  /**
   * PBKDF2 iteration count (must match the Worker's value).
   * This is stored in the .gob container for informational purposes.
   */
  KDF_ITERATIONS: 200_000,

  /**
   * Salt length in bytes (16 bytes = 128 bits).
   */
  SALT_BYTES: 16,

  /**
   * AES-GCM IV length in bytes (12 bytes = 96 bits, NIST recommended).
   */
  IV_BYTES: 12,
};

export default config;
