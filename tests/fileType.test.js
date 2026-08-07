const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fileType = require('../src/lib/fileType');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indigent-filetype-'));

function write(name, bytes) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'latin1'));
  return p;
}

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PDF = '%PDF-1.4\nrest of the document';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const DOC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const HTML = '<html><script>alert(document.domain)</script></html>';

test('identifies each allowed type from its signature', () => {
  assert.equal(fileType.sniff(write('a.pdf', PDF)).mime, 'application/pdf');
  assert.equal(fileType.sniff(write('a.png', PNG)).mime, 'image/png');
  assert.equal(fileType.sniff(write('a.jpg', JPEG)).mime, 'image/jpeg');
  assert.equal(fileType.sniff(write('a.doc', DOC)).mime, 'application/msword');
  assert.match(fileType.sniff(write('a.docx', DOCX)).mime, /wordprocessingml/);
});

test('returns null for content with no recognised signature', () => {
  assert.equal(fileType.sniff(write('evil.pdf', HTML)), null,
    'HTML named .pdf must not be identified as a document');
  assert.equal(fileType.sniff(write('empty.pdf', '')), null);
  assert.equal(fileType.sniff(write('text.pdf', 'just some plain text')), null);
});

test('returns null rather than throwing for a missing file', () => {
  assert.equal(fileType.sniff(path.join(tmp, 'does-not-exist.pdf')), null);
});

test('extension must agree with the sniffed content', () => {
  const pdf = fileType.sniff(write('b.pdf', PDF));
  assert.equal(fileType.extensionAgrees(pdf, '.pdf'), true);
  assert.equal(fileType.extensionAgrees(pdf, '.png'), false,
    'PDF bytes under a .png name must be rejected');

  const jpeg = fileType.sniff(write('b.jpg', JPEG));
  assert.equal(fileType.extensionAgrees(jpeg, '.jpg'), true);
  assert.equal(fileType.extensionAgrees(jpeg, '.jpeg'), true, 'both spellings are valid');
  assert.equal(fileType.extensionAgrees(jpeg, '.JPG'), true, 'case-insensitive');
  assert.equal(fileType.extensionAgrees(jpeg, '.pdf'), false);
});

test('only non-executable types may render inline', () => {
  assert.equal(fileType.isInlineSafe('application/pdf'), true);
  assert.equal(fileType.isInlineSafe('image/png'), true);
  assert.equal(fileType.isInlineSafe('image/jpeg'), true);

  // Word documents download rather than render; anything unknown must too.
  assert.equal(fileType.isInlineSafe('application/msword'), false);
  assert.equal(fileType.isInlineSafe('text/html'), false);
  assert.equal(fileType.isInlineSafe('image/svg+xml'), false, 'SVG can carry script');
  assert.equal(fileType.isInlineSafe('application/octet-stream'), false);
});

test('a truncated file shorter than the signature is not misidentified', () => {
  assert.equal(fileType.sniff(write('short.png', Buffer.from([0x89, 0x50]))), null);
});
