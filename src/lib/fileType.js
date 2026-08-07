const fs = require('fs');

/**
 * Content sniffing for uploads.
 *
 * multer reports `mimetype` from the client's own Content-Type header, so it is
 * attacker-controlled. Echoing that back on download let a file named `x.pdf`
 * declare `text/html` and execute as a script on the API's origin — with ID
 * copies and bank statements behind the same origin.
 *
 * This reads the leading bytes off disk and decides the type itself. Anything
 * that does not match a known-good signature is rejected.
 */

const SIGNATURES = [
  { mime: 'application/pdf',  ext: '.pdf',  bytes: [0x25, 0x50, 0x44, 0x46] },                          // %PDF
  { mime: 'image/jpeg',       ext: '.jpg',  bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png',        ext: '.png',  bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // .docx is a zip container; .doc is the older OLE2 compound file.
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/msword', ext: '.doc', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

/** Types that are safe to render in the browser. Everything else downloads. */
const INLINE_SAFE = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'];

function matches(buffer, signature) {
  if (buffer.length < signature.bytes.length) return false;
  return signature.bytes.every((byte, i) => buffer[i] === byte);
}

/**
 * Inspect a file on disk.
 * Returns { mime, ext } for a recognised type, or null when nothing matches.
 */
function sniff(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8);
    const read = fs.readSync(fd, buffer, 0, 8, 0);
    const head = buffer.subarray(0, read);
    return SIGNATURES.find((s) => matches(head, s)) || null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * The sniffed type must also agree with the claimed extension, so a PDF cannot
 * be stored as `payload.html` and later served under a filename the browser
 * would treat as markup.
 */
function extensionAgrees(sniffed, extension) {
  const ext = String(extension || '').toLowerCase();
  if (sniffed.ext === '.jpg') return ext === '.jpg' || ext === '.jpeg';
  return sniffed.ext === ext;
}

const isInlineSafe = (mime) => INLINE_SAFE.has(mime);

module.exports = { sniff, extensionAgrees, isInlineSafe, ALLOWED_EXTENSIONS, INLINE_SAFE };
