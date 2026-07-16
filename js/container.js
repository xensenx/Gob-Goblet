/**
 * Goblet Frontend — Container Module
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles construction and parsing of the .gob container format (v1).
 *
 * .gob format (JSON):
 * {
 *   "version": 1,
 *   "timestamp": "2026-07-16T12:34:56.000Z",
 *   "originalName": "secret.pdf",
 *   "salt": "<base64-16-bytes>",
 *   "iv": "<base64-12-bytes>",
 *   "ciphertext": "<base64-AES-GCM-output>",
 *   "kdf": "PBKDF2",
 *   "kdfParams": { "hash": "SHA-256", "iterations": 200000 },
 *   "cipher": "AES-GCM-256"
 * }
 */

import config from './config.js';

// ─── Base64 helpers ──────────────────────────────────────────────────────────

/**
 * Encodes a Uint8Array to a standard base64 string (no line breaks).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let binaryStr = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binaryStr += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryStr);
}

/**
 * Decodes a standard base64 string to Uint8Array.
 * Throws a TypeError if the string is not valid base64.
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBytes(b64) {
  let binaryStr;
  try {
    binaryStr = atob(b64);
  } catch {
    throw new TypeError('Invalid base64 string.');
  }
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

/**
 * Converts an ArrayBuffer to Uint8Array.
 * @param {ArrayBuffer} buf
 * @returns {Uint8Array}
 */
export function bufferToBytes(buf) {
  return new Uint8Array(buf);
}

// ─── Container builder ───────────────────────────────────────────────────────

/**
 * Builds a .gob JSON container string.
 *
 * @param {object} params
 * @param {string}     params.originalName  — Original filename
 * @param {Uint8Array} params.salt           — 16-byte random salt
 * @param {Uint8Array} params.iv             — 12-byte AES-GCM IV
 * @param {Uint8Array} params.ciphertext     — AES-GCM ciphertext (includes auth tag)
 * @returns {string} JSON string representing the .gob container
 */
export function buildGobContainer({ originalName, salt, iv, ciphertext }) {
  const container = {
    version: 1,
    timestamp: new Date().toISOString(),
    originalName: originalName,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    kdf: 'PBKDF2',
    kdfParams: {
      hash: 'SHA-256',
      iterations: config.KDF_ITERATIONS,
    },
    cipher: 'AES-GCM-256',
  };
  return JSON.stringify(container);
}

// ─── Container parser ────────────────────────────────────────────────────────

/**
 * Parses and validates a .gob JSON string.
 *
 * @param {string} text  — Raw text content of the uploaded file
 * @returns {{
 *   version: number,
 *   timestamp: string,
 *   originalName: string,
 *   salt: Uint8Array,
 *   iv: Uint8Array,
 *   ciphertext: Uint8Array,
 *   saltB64: string,
 *   kdf: string,
 *   kdfParams: object,
 *   cipher: string
 * }}
 * @throws {GobletError} with a user-friendly message on any validation failure
 */
export function parseGobContainer(text) {
  // ── JSON parse ────────────────────────────────────────────────────────────
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new GobletError('Invalid Goblet file — cannot parse as JSON.');
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new GobletError('Invalid Goblet file — not a JSON object.');
  }

  // ── Version check ─────────────────────────────────────────────────────────
  if (obj.version === undefined || obj.version === null) {
    throw new GobletError('Invalid Goblet file — missing version field.');
  }
  if (typeof obj.version !== 'number') {
    throw new GobletError('Invalid Goblet file — version must be a number.');
  }
  if (obj.version !== 1) {
    throw new GobletError(
      `Unsupported Goblet version (${obj.version}). This app only supports version 1.`,
    );
  }

  // ── Required string fields ────────────────────────────────────────────────
  const requiredStrings = ['originalName', 'salt', 'iv', 'ciphertext'];
  for (const field of requiredStrings) {
    if (typeof obj[field] !== 'string' || obj[field].length === 0) {
      throw new GobletError(`Invalid Goblet file — missing or empty field: ${field}.`);
    }
  }

  // ── Decode binary fields ──────────────────────────────────────────────────
  let saltBytes, ivBytes, ciphertextBytes;

  try {
    saltBytes = base64ToBytes(obj.salt);
  } catch {
    throw new GobletError('Invalid Goblet file — salt field is not valid base64.');
  }

  try {
    ivBytes = base64ToBytes(obj.iv);
  } catch {
    throw new GobletError('Invalid Goblet file — iv field is not valid base64.');
  }

  try {
    ciphertextBytes = base64ToBytes(obj.ciphertext);
  } catch {
    throw new GobletError('Invalid Goblet file — ciphertext field is not valid base64.');
  }

  // ── Size checks ────────────────────────────────────────────────────────────
  if (saltBytes.length !== 16) {
    throw new GobletError('Invalid Goblet file — salt must be 16 bytes.');
  }
  if (ivBytes.length !== 12) {
    throw new GobletError('Invalid Goblet file — iv must be 12 bytes.');
  }
  if (ciphertextBytes.length < 16) {
    // AES-GCM minimum: 16-byte auth tag + 0 bytes plaintext
    throw new GobletError('Invalid Goblet file — ciphertext is too short.');
  }

  return {
    version: obj.version,
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null,
    originalName: obj.originalName,
    // decoded bytes (for crypto operations)
    salt: saltBytes,
    iv: ivBytes,
    ciphertext: ciphertextBytes,
    // keep raw b64 salt for Worker call
    saltB64: obj.salt,
    // optional informational fields
    kdf: obj.kdf ?? 'PBKDF2',
    kdfParams: obj.kdfParams ?? { hash: 'SHA-256', iterations: config.KDF_ITERATIONS },
    cipher: obj.cipher ?? 'AES-GCM-256',
  };
}

/**
 * Attempts to detect if a file is a Goblet container by reading its content.
 * Returns the parsed container if valid, or null if it's not a .gob file.
 *
 * @param {string} text
 * @returns {{ parsed: object, isGob: true } | { isGob: false }}
 */
export function tryParseGob(text) {
  try {
    const obj = JSON.parse(text);
    // A .gob has a numeric version field and required string fields
    if (
      typeof obj === 'object' &&
      obj !== null &&
      typeof obj.version === 'number' &&
      typeof obj.salt === 'string' &&
      typeof obj.iv === 'string' &&
      typeof obj.ciphertext === 'string'
    ) {
      return { isGob: true, obj };
    }
  } catch {
    // Not JSON at all
  }
  return { isGob: false };
}

// ─── Custom error class ───────────────────────────────────────────────────────

/**
 * GobletError — thrown for user-facing validation and parse errors.
 * The message is safe to display directly in the UI.
 */
export class GobletError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GobletError';
  }
}
