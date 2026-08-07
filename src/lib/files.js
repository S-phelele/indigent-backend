const fs = require('fs');
const path = require('path');

/**
 * Filesystem cleanup for deletions.
 *
 * Database rows cascade, but the uploaded bytes do not. Without this, deleting an
 * application or an applicant would leave their ID copies and bank statements on
 * disk indefinitely — the opposite of what a deletion is for.
 */

const uploadRoot = () => path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');

/** Resolve a stored path, refusing anything that escapes the upload directory. */
function resolveStored(filePath) {
  if (!filePath) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const root = uploadRoot();
  // Guards against a malformed or tampered path reaching outside uploads.
  if (!abs.startsWith(root)) return null;
  return abs;
}

/** Delete the files behind a set of document rows. Returns how many were removed. */
function removeDocumentFiles(documents = []) {
  let removed = 0;
  for (const doc of documents) {
    const abs = resolveStored(doc.filePath);
    if (!abs) continue;
    try {
      if (fs.existsSync(abs)) { fs.unlinkSync(abs); removed += 1; }
    } catch (error) {
      console.error('[files] could not delete', abs, error.message);
    }
  }
  return removed;
}

/** Remove an application's upload folder once its files are gone. */
function removeApplicationDir(applicationId) {
  const dir = path.join(uploadRoot(), applicationId);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.error('[files] could not remove directory', dir, error.message);
  }
}

module.exports = { removeDocumentFiles, removeApplicationDir, resolveStored, uploadRoot };
