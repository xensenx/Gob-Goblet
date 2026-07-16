/**
 * Goblet Frontend — App Module
 * ─────────────────────────────────────────────────────────────────────────────
 * Main application logic and UI state machine.
 *
 * States: idle → file-selected → mode-determined → processing → done / error
 *
 * Encrypt flow:
 *   file selected (plain) → password prompt → derive key → encrypt → self-verify → download .gob
 *
 * Decrypt flow:
 *   file selected (.gob) → parse container → password prompt → derive key → decrypt → download original
 */

import config from './config.js';
import { buildGobContainer, parseGobContainer, tryParseGob, GobletError } from './container.js';
import {
  isCryptoSupported,
  randomBytes,
  deriveKeyFromWorker,
  encryptFile,
  decryptFile,
  selfVerify,
} from './crypto.js';
import { bytesToBase64 } from './container.js';

// ─── App State ───────────────────────────────────────────────────────────────

const state = {
  /** @type {'idle'|'file-selected'|'processing'|'done'|'error'} */
  phase: 'idle',
  /** @type {'encrypt'|'decrypt'|null} */
  mode: null,
  /** @type {File|null} */
  file: null,
  /** @type {object|null} parsed .gob container */
  gobData: null,
  /** Whether a processing operation is currently running */
  busy: false,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const dom = {
  dropZone:        () => document.getElementById('drop-zone'),
  fileInput:       () => document.getElementById('file-input'),
  fileSelectBtn:   () => document.getElementById('file-select-btn'),
  fileName:        () => document.getElementById('file-name'),
  fileSize:        () => document.getElementById('file-size'),
  fileMeta:        () => document.getElementById('file-meta'),
  modeBadge:       () => document.getElementById('mode-badge'),
  modeSection:     () => document.getElementById('mode-section'),
  passwordSection: () => document.getElementById('password-section'),
  passwordInput:   () => document.getElementById('password-input'),
  passwordToggle:  () => document.getElementById('password-toggle'),
  passwordWarn:    () => document.getElementById('password-warn'),
  gobMetaCard:     () => document.getElementById('gob-meta-card'),
  gobOrigName:     () => document.getElementById('gob-orig-name'),
  gobTimestamp:    () => document.getElementById('gob-timestamp'),
  actionBtn:       () => document.getElementById('action-btn'),
  resetBtn:        () => document.getElementById('reset-btn'),
  statusBar:       () => document.getElementById('status-bar'),
  statusText:      () => document.getElementById('status-text'),
  statusIcon:      () => document.getElementById('status-icon'),
  progressRing:    () => document.getElementById('progress-ring'),
  cryptoWarning:   () => document.getElementById('crypto-warning'),
  mainCard:        () => document.getElementById('main-card'),
};

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Check Web Crypto support
  if (!isCryptoSupported()) {
    dom.cryptoWarning().classList.remove('hidden');
    dom.mainCard().classList.add('hidden');
    return;
  }

  attachEventListeners();
  renderIdle();
});

// ─── Event Listeners ──────────────────────────────────────────────────────────

function attachEventListeners() {
  // File select button
  dom.fileSelectBtn().addEventListener('click', () => dom.fileInput().click());

  // File input change
  dom.fileInput().addEventListener('change', (e) => {
    const files = e.target.files;
    handleFileList(files);
    // Reset so same file can be re-selected
    e.target.value = '';
  });

  // Drag and drop
  const dz = dom.dropZone();
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('drag-over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    handleFileList(e.dataTransfer.files);
  });

  // Password input — show/hide empty warning
  dom.passwordInput().addEventListener('input', () => {
    const isEmpty = dom.passwordInput().value.length === 0;
    dom.passwordWarn().classList.toggle('visible', isEmpty);
    updateActionButton();
  });

  // Password visibility toggle
  dom.passwordToggle().addEventListener('click', () => {
    const inp = dom.passwordInput();
    const isText = inp.type === 'text';
    inp.type = isText ? 'password' : 'text';
    dom.passwordToggle().textContent = isText ? '👁' : '🙈';
    dom.passwordToggle().setAttribute('aria-label', isText ? 'Show password' : 'Hide password');
  });

  // Action button (Encrypt / Decrypt)
  dom.actionBtn().addEventListener('click', handleAction);

  // Reset button
  dom.resetBtn().addEventListener('click', handleReset);
}

// ─── File handling ────────────────────────────────────────────────────────────

/**
 * Handles a FileList from either drag-drop or file input.
 * @param {FileList} files
 */
async function handleFileList(files) {
  if (state.busy) return;

  if (!files || files.length === 0) return;

  if (files.length > 1) {
    setStatus('error', '⚠️ Please select only one file at a time.');
    return;
  }

  const file = files[0];

  // Size check
  if (file.size > config.MAX_FILE_SIZE) {
    setStatus(
      'error',
      `⚠️ File exceeds the 25 MB limit (${formatBytes(file.size)}). Please choose a smaller file.`,
    );
    return;
  }

  state.file = file;
  state.phase = 'file-selected';

  // Determine mode
  await determineMode(file);
}

/**
 * Reads the file and determines whether it's a .gob (decrypt) or plain file (encrypt).
 * @param {File} file
 */
async function determineMode(file) {
  setStatus('idle', 'Analysing file…');

  let mode = 'encrypt';
  let gobData = null;

  // Attempt to read as text and detect .gob structure
  // Only try if file is small enough to be a JSON container
  if (file.size < 50 * 1024 * 1024) {
    try {
      const text = await readFileAsText(file);
      const result = tryParseGob(text);
      if (result.isGob) {
        mode = 'decrypt';
        // Full validation parse
        try {
          gobData = parseGobContainer(text);
        } catch (err) {
          if (err instanceof GobletError) {
            setStatus('error', err.message);
            return;
          }
          setStatus('error', 'Invalid Goblet file — cannot parse.');
          return;
        }
      }
    } catch {
      // Not readable as text — treat as binary plain file
      mode = 'encrypt';
    }
  }

  state.mode = mode;
  state.gobData = gobData;
  state.phase = 'mode-determined';

  renderFileSelected(file, mode, gobData);
}

// ─── Action handler ───────────────────────────────────────────────────────────

async function handleAction() {
  if (state.busy) return;

  const password = dom.passwordInput().value;
  // Note: we allow empty password (per spec) but warn in UI

  if (state.mode === 'encrypt') {
    await runEncrypt(state.file, password);
  } else {
    await runDecrypt(state.gobData, password);
  }
}

// ─── Encrypt flow ─────────────────────────────────────────────────────────────

/**
 * Full encryption flow.
 * @param {File} file
 * @param {string} password
 */
async function runEncrypt(file, password) {
  setBusy(true);

  try {
    // 1. Read file bytes
    setStatus('processing', '📖 Reading file…');
    const fileBytes = await readFileAsArrayBuffer(file);

    // 2. Generate salt and IV
    const salt = randomBytes(config.SALT_BYTES);
    const iv = randomBytes(config.IV_BYTES);
    const saltB64 = bytesToBase64(salt);

    // 3. Derive key via Worker
    setStatus('processing', '🔑 Deriving encryption key…');
    const cryptoKey = await deriveKeyFromWorker(password, saltB64);

    // 4. Encrypt
    setStatus('processing', '🔒 Encrypting…');
    const ciphertext = await encryptFile(fileBytes, cryptoKey, iv);

    // 5. Self-verify
    setStatus('processing', '✅ Verifying…');
    await selfVerify(new Uint8Array(fileBytes), ciphertext, cryptoKey, iv);

    // 6. Build container and download
    setStatus('processing', '📦 Packaging…');
    const gobJson = buildGobContainer({
      originalName: file.name,
      salt,
      iv,
      ciphertext,
    });

    const gobFilename = file.name + '.gob';
    triggerDownload(new TextEncoder().encode(gobJson), gobFilename, 'application/json');

    setStatus('done', `✨ File has been gobbled! "${gobFilename}" downloaded.`);
    renderDone();
  } catch (err) {
    handleError(err);
  } finally {
    setBusy(false);
  }
}

// ─── Decrypt flow ─────────────────────────────────────────────────────────────

/**
 * Full decryption flow.
 * @param {object} gobData   — Parsed .gob container
 * @param {string} password
 */
async function runDecrypt(gobData, password) {
  setBusy(true);

  try {
    // 1. Derive key via Worker (using salt from container)
    setStatus('processing', '🔑 Deriving decryption key…');
    const saltB64 = bytesToBase64(gobData.salt);
    const cryptoKey = await deriveKeyFromWorker(password, saltB64);

    // 2. Decrypt
    setStatus('processing', '🔓 Decrypting…');
    const plainBytes = await decryptFile(gobData.ciphertext, cryptoKey, gobData.iv);

    // 3. Download original file
    triggerDownload(plainBytes, gobData.originalName, 'application/octet-stream');

    setStatus('done', `🎉 Your offering is returned! "${gobData.originalName}" downloaded.`);
    renderDone();
  } catch (err) {
    handleError(err);
  } finally {
    setBusy(false);
  }
}

// ─── UI Render helpers ────────────────────────────────────────────────────────

function renderIdle() {
  dom.modeSection().classList.add('hidden');
  dom.passwordSection().classList.add('hidden');
  dom.gobMetaCard().classList.add('hidden');
  dom.resetBtn().classList.add('hidden');
  dom.fileMeta().classList.add('hidden');
  dom.actionBtn().classList.add('hidden');
  dom.dropZone().classList.remove('has-file');
  dom.modeBadge().textContent = '';
  dom.modeBadge().className = 'mode-badge';
  dom.passwordInput().value = '';
  dom.passwordWarn().classList.remove('visible');
  setStatus('idle', 'Drop a file here or click to select');
}

/**
 * @param {File} file
 * @param {'encrypt'|'decrypt'} mode
 * @param {object|null} gobData
 */
function renderFileSelected(file, mode, gobData) {
  // File info
  dom.fileName().textContent = file.name;
  dom.fileSize().textContent = formatBytes(file.size);
  dom.fileMeta().classList.remove('hidden');
  dom.dropZone().classList.add('has-file');

  // Mode badge
  const badge = dom.modeBadge();
  badge.classList.remove('hidden');
  if (mode === 'encrypt') {
    badge.textContent = '🔒 Encrypt Mode';
    badge.className = 'mode-badge encrypt';
  } else {
    badge.textContent = '🔓 Decrypt Mode';
    badge.className = 'mode-badge decrypt';
  }
  dom.modeSection().classList.remove('hidden');

  // .gob metadata card
  if (mode === 'decrypt' && gobData) {
    dom.gobOrigName().textContent = gobData.originalName;
    dom.gobTimestamp().textContent = gobData.timestamp
      ? new Date(gobData.timestamp).toLocaleString()
      : 'Unknown';
    dom.gobMetaCard().classList.remove('hidden');
  } else {
    dom.gobMetaCard().classList.add('hidden');
  }

  // Password section
  dom.passwordSection().classList.remove('hidden');
  dom.passwordInput().placeholder =
    mode === 'encrypt' ? 'Enter a strong password to protect this file' : 'Enter your password';
  dom.passwordInput().focus();

  // Action button
  dom.actionBtn().textContent = mode === 'encrypt' ? '🔒 Encrypt & Download' : '🔓 Decrypt & Download';
  dom.actionBtn().classList.remove('hidden');
  updateActionButton();

  // Reset button
  dom.resetBtn().classList.remove('hidden');

  setStatus('idle', mode === 'encrypt' ? 'Enter a password and click Encrypt' : 'Enter your password and click Decrypt');
}

function renderDone() {
  dom.actionBtn().classList.add('hidden');
  dom.passwordInput().value = '';
  dom.passwordSection().classList.add('hidden');
  // Keep reset button visible so user can go again
}

function updateActionButton() {
  const btn = dom.actionBtn();
  const hasFile = state.file !== null;
  btn.disabled = !hasFile || state.busy;
}

// ─── Status bar ───────────────────────────────────────────────────────────────

/**
 * @param {'idle'|'processing'|'done'|'error'} type
 * @param {string} message
 */
function setStatus(type, message) {
  const bar = dom.statusBar();
  const text = dom.statusText();
  const ring = dom.progressRing();

  bar.className = `status-bar status-${type}`;
  text.textContent = message;

  // Show spinner only when processing
  ring.style.display = type === 'processing' ? 'block' : 'none';
}

// ─── Error handler ────────────────────────────────────────────────────────────

function handleError(err) {
  if (err instanceof GobletError) {
    setStatus('error', `❌ ${err.message}`);
  } else {
    console.error('[Goblet] Unexpected error:', err);
    setStatus('error', '❌ An unexpected error occurred. Please try again.');
  }
}

// ─── Reset ────────────────────────────────────────────────────────────────────

function handleReset() {
  if (state.busy) return;
  state.file = null;
  state.mode = null;
  state.gobData = null;
  state.phase = 'idle';
  renderIdle();
}

// ─── Busy state ───────────────────────────────────────────────────────────────

function setBusy(busy) {
  state.busy = busy;
  dom.actionBtn().disabled = busy;
  dom.fileSelectBtn().disabled = busy;
  dom.resetBtn().disabled = busy;
  dom.dropZone().style.pointerEvents = busy ? 'none' : '';
}

// ─── File I/O helpers ─────────────────────────────────────────────────────────

/**
 * Reads a File as an ArrayBuffer.
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new GobletError('Failed to read the file.'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Reads a File as a UTF-8 string.
 * @param {File} file
 * @returns {Promise<string>}
 */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Cannot read file as text'));
    reader.readAsText(file, 'utf-8');
  });
}

/**
 * Triggers a file download in the browser.
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {string} mimeType
 */
function triggerDownload(bytes, filename, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Clean up
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Formats a byte count as a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
