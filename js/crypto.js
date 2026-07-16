/**
 * Goblet Frontend — Crypto Module
 * ─────────────────────────────────────────────────────────────────────────────
 * Wraps all Web Crypto API operations:
 *   • Key derivation via the Cloudflare Worker (pepper + PBKDF2)
 *   • AES-256-GCM file encryption
 *   • AES-256-GCM file decryption
 *
 * The actual PBKDF2 with the secret pepper runs on the Worker.
 * The browser only performs AES-GCM encrypt/decrypt.
 */

import config from './config.js';
import { GobletError } from './container.js';

// ─── Browser support check ────────────────────────────────────────────────────

/**
 * Returns true if the browser supports the required Web Crypto APIs.
 * @returns {boolean}
 */
export function isCryptoSupported() {
  return (
    typeof window !== 'undefined' &&
    window.crypto != null &&
    typeof window.crypto.subtle?.importKey === 'function' &&
    typeof window.crypto.subtle?.encrypt === 'function' &&
    typeof window.crypto.subtle?.decrypt === 'function' &&
    typeof window.crypto.getRandomValues === 'function'
  );
}

// ─── Random byte generation ───────────────────────────────────────────────────

/**
 * Generates cryptographically random bytes.
 * @param {number} length — number of bytes
 * @returns {Uint8Array}
 */
export function randomBytes(length) {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

// ─── Key derivation (via Worker) ─────────────────────────────────────────────

/**
 * Calls the Goblet Worker to derive an AES-256 key from the user's password
 * and the given salt. The Worker mixes the server pepper into the derivation.
 *
 * @param {string} password — UTF-8 password from user
 * @param {string} saltB64  — base64-encoded 16-byte salt
 * @returns {Promise<CryptoKey>} AES-GCM CryptoKey (non-extractable, encrypt+decrypt)
 * @throws {GobletError} on network or server errors
 */
export async function deriveKeyFromWorker(password, saltB64) {
  const url = `${config.WORKER_URL}/derive-key`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, salt: saltB64 }),
    });
  } catch (networkErr) {
    throw new GobletError(
      'Key service unreachable. Check your internet connection and try again.',
    );
  }

  // Parse JSON response
  let data;
  try {
    data = await response.json();
  } catch {
    throw new GobletError('Unexpected response from key service. Please try again.');
  }

  if (!response.ok) {
    // Server returned an error — safe to show a generic message
    const serverMsg = data?.error ?? 'Unknown server error.';
    if (response.status >= 500) {
      throw new GobletError('An internal error occurred on the key service. Please try again later.');
    }
    if (response.status === 403) {
      throw new GobletError('Access denied by key service (CORS). Check configuration.');
    }
    throw new GobletError(`Key service error: ${serverMsg}`);
  }

  if (typeof data.key !== 'string' || data.key.length === 0) {
    throw new GobletError('Key service returned an invalid response.');
  }

  // Decode the raw key bytes
  let rawKeyBytes;
  try {
    rawKeyBytes = _base64ToBytes(data.key);
  } catch {
    throw new GobletError('Key service returned an undecodable key.');
  }

  if (rawKeyBytes.length !== 32) {
    throw new GobletError(`Key service returned a key of wrong length (${rawKeyBytes.length} bytes, expected 32).`);
  }

  // Import as a non-extractable CryptoKey for AES-GCM
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawKeyBytes,
      { name: 'AES-GCM' },
      false, // non-extractable — key stays in browser memory only
      ['encrypt', 'decrypt'],
    );
    return cryptoKey;
  } catch (err) {
    throw new GobletError('Failed to import derived key. Please try again.');
  }
}

// ─── AES-256-GCM Encryption ───────────────────────────────────────────────────

/**
 * Encrypts file bytes using AES-256-GCM.
 *
 * @param {ArrayBuffer|Uint8Array} fileBytes — plaintext file content
 * @param {CryptoKey} cryptoKey              — AES-GCM CryptoKey from deriveKeyFromWorker
 * @param {Uint8Array} iv                    — 12-byte IV (generated fresh per file)
 * @returns {Promise<Uint8Array>} ciphertext (includes 16-byte GCM auth tag appended)
 * @throws {GobletError} if encryption fails
 */
export async function encryptFile(fileBytes, cryptoKey, iv) {
  try {
    const cipherBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        // No additional authenticated data (AAD) in v1
      },
      cryptoKey,
      fileBytes,
    );
    return new Uint8Array(cipherBuffer);
  } catch (err) {
    throw new GobletError('Encryption failed unexpectedly. Please try again.');
  }
}

// ─── AES-256-GCM Decryption ───────────────────────────────────────────────────

/**
 * Decrypts AES-256-GCM ciphertext back to plaintext.
 *
 * @param {Uint8Array} ciphertextBytes — ciphertext (includes GCM auth tag)
 * @param {CryptoKey} cryptoKey        — AES-GCM CryptoKey
 * @param {Uint8Array} iv              — 12-byte IV (from .gob container)
 * @returns {Promise<Uint8Array>} plaintext file bytes
 * @throws {GobletError} on wrong password, tampered data, or other failures
 */
export async function decryptFile(ciphertextBytes, cryptoKey, iv) {
  try {
    const plainBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv,
      },
      cryptoKey,
      ciphertextBytes,
    );
    return new Uint8Array(plainBuffer);
  } catch (err) {
    // AES-GCM auth tag failure = wrong password OR tampered ciphertext
    // We deliberately don't reveal which — per spec
    throw new GobletError('Incorrect password or corrupt file. Goblet refuses to open this.');
  }
}

// ─── Self-verification ────────────────────────────────────────────────────────

/**
 * Immediately decrypts a just-encrypted ciphertext to verify correctness.
 * Used after encryption before triggering download.
 *
 * @param {Uint8Array} originalBytes
 * @param {Uint8Array} ciphertextBytes
 * @param {CryptoKey} cryptoKey
 * @param {Uint8Array} iv
 * @returns {Promise<void>}
 * @throws {GobletError} if verification fails (should never happen)
 */
export async function selfVerify(originalBytes, ciphertextBytes, cryptoKey, iv) {
  let decrypted;
  try {
    decrypted = await decryptFile(ciphertextBytes, cryptoKey, iv);
  } catch {
    throw new GobletError(
      'Self-verification failed after encryption. The file was not downloaded for safety. Please try again.',
    );
  }

  // Byte-by-byte comparison
  if (decrypted.length !== originalBytes.length) {
    throw new GobletError('Self-verification mismatch (length). File not downloaded.');
  }
  for (let i = 0; i < decrypted.length; i++) {
    if (decrypted[i] !== originalBytes[i]) {
      throw new GobletError('Self-verification mismatch (content). File not downloaded.');
    }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _base64ToBytes(b64) {
  const binaryStr = atob(b64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}
