const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { protect } = require('../middleware/auth');
const { uploadLimiter } = require('../lib/rateLimit');
const fileType = require('../lib/fileType');
const notify = require('../lib/notify');
const access = require('../lib/applicationAccess');
const slots = require('../lib/documentSlots');
const cache = require('../lib/cache');

const router = express.Router();
const uuidv4 = () => crypto.randomUUID();

const uploadDir = process.env.UPLOAD_DIR || './uploads';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const appDir = path.join(uploadDir, req.params.applicationId || 'temp');
    if (!fs.existsSync(appDir)) {
      fs.mkdirSync(appDir, { recursive: true });
    }
    cb(null, appDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  // Extension check only — it is cheap and rejects the obvious cases before the
  // bytes are written. The authoritative check is the content sniff below, once
  // the file is on disk.
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (fileType.ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error('That kind of file cannot be uploaded. Please send a PDF, a photo, or a Word document.'));
  },
});

/** Remove a rejected upload; never leave unvalidated bytes on disk. */
function discard(file) {
  if (!file?.path) return;
  try { fs.unlinkSync(file.path); } catch { /* already gone */ }
}

router.use(...protect);
router.use(cache.invalidateOn(cache.TAGS.DOCUMENTS, cache.TAGS.ANALYTICS));

// Upload document for an application
router.post('/:applicationId/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { documentId, type } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please choose a file to upload.' });
    }

    // Decide the type from the bytes, not from the client's Content-Type header.
    const sniffed = fileType.sniff(req.file.path);
    if (!sniffed) {
      discard(req.file);
      return res.status(400).json({
        success: false,
        message: 'That file is not a valid PDF, JPG, PNG or Word document.',
      });
    }

    const claimedExt = path.extname(req.file.originalname).toLowerCase();
    if (!fileType.extensionAgrees(sniffed, claimedExt)) {
      discard(req.file);
      return res.status(400).json({
        success: false,
        message: `The file contents do not match its ${claimedExt} extension.`,
      });
    }

    const application = await prisma.application.findUnique({
      where: { id: applicationId },
    });

    if (!application) {
      discard(req.file);
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    // Owner, administrator, or the councillor who captured this at the door and
    // is photographing the household's documents on the spot.
    if (!access.canView(req.user, application)) {
      discard(req.file);
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }
    if (req.user.role === 'COUNCILLOR' && !access.canEdit(req.user, application)) {
      discard(req.file);
      return res.status(400).json({
        success: false,
        message: 'This application has been submitted. Documents can no longer be added in the field.',
      });
    }

    /**
     * What an applicant may change after submitting.
     *
     * Required documents are frozen: the reviewer must see exactly the evidence
     * the decision rests on. Optional documents are not — an applicant who
     * remembers a proof of grant, or is asked for more support while waiting,
     * should be able to add it rather than start again. A decided application is
     * closed to both.
     */
    const isDraft = application.status === 'DRAFT';
    const isAdmin = req.user.role === 'ADMIN';
    const targetsExistingSlot = Boolean(documentId);

    let existingSlot = null;
    if (targetsExistingSlot) {
      existingSlot = await prisma.document.findUnique({ where: { id: documentId } });
      if (!existingSlot || existingSlot.applicationId !== applicationId) {
        discard(req.file);
        return res.status(404).json({ success: false, message: 'That document slot does not belong to this application' });
      }
    }

    if (!isDraft && !isAdmin) {
      if (application.status !== 'PENDING') {
        discard(req.file);
        return res.status(400).json({
          success: false,
          message: 'This application has been decided and can no longer be changed.',
        });
      }
      if (targetsExistingSlot && existingSlot.importance === 'REQUIRED') {
        discard(req.file);
        return res.status(400).json({
          success: false,
          message: 'Required documents cannot be replaced once the application has been submitted. Contact your municipal office.',
        });
      }
    }

    let document;

    if (documentId) {
      // Remove old file if replacing
      const existing = existingSlot;
      if (existing?.filePath && fs.existsSync(existing.filePath)) {
        try { fs.unlinkSync(existing.filePath); } catch (_) {}
      }

      document = await prisma.document.update({
        where: { id: documentId },
        data: {
          fileName: req.file.originalname,
          filePath: req.file.path,
          mimeType: sniffed.mime, // sniffed, never the client-supplied header
          fileSize: req.file.size,
          status: 'Uploaded',
          uploadedAt: new Date(),
        },
      });
    } else {
      document = await prisma.document.create({
        data: {
          applicationId,
          name: req.file.originalname,
          type: type || 'OTHER',
          importance: 'OPTIONAL',
          fileName: req.file.originalname,
          filePath: req.file.path,
          mimeType: sniffed.mime, // sniffed, never the client-supplied header
          fileSize: req.file.size,
          status: 'Uploaded',
          uploadedAt: new Date(),
        },
      });
    }

    // Evidence changing on an application already in the queue is something a
    // reviewer needs to know about, not discover by chance.
    if (application.status === 'PENDING' && !isAdmin) {
      await notify.toAdmins({
        type: notify.TYPE.APPLICATION_UPDATED,
        title: 'Supporting document added to an application under review',
        body: `${application.reference || application.id.slice(0, 8)} — the applicant added "${document.name}".`,
        link: `/applications/${application.id}`,
        entityType: 'Application',
        entityId: application.id,
      });
    }

    res.json({
      success: true,
      message: 'Document uploaded successfully',
      data: document,
    });
  } catch (error) {
    console.error('upload error:', error);
    discard(req.file);
    // multer's own errors describe something the applicant can fix (size, type).
    // Anything else is internal and must not be echoed back.
    const isUploadError = error instanceof multer.MulterError || /Invalid file type/i.test(error.message || '');
    res.status(isUploadError ? 400 : 500).json({
      success: false,
      message: isUploadError
        ? (error.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the 10 MB limit.' : error.message)
        : 'Upload failed. Please try again.',
    });
  }
});

// View / download a document file (authenticated — admin or owner)
router.get('/file/:documentId', async (req, res) => {
  try {
    const document = await prisma.document.findUnique({
      where: { id: req.params.documentId },
      include: { application: true },
    });

    if (!document) {
      return res.status(404).json({ success: false, message: 'We could not find that document.' });
    }

    if (!access.canView(req.user, document.application)) {
      return res.status(404).json({ success: false, message: 'We could not find that document.' });
    }

    if (!document.filePath || document.status !== 'Uploaded') {
      return res.status(404).json({ success: false, message: 'File not uploaded yet' });
    }

    // Resolve path (relative paths are relative to backend working directory)
    const absolutePath = path.isAbsolute(document.filePath)
      ? document.filePath
      : path.resolve(process.cwd(), document.filePath);

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ success: false, message: 'File missing on server' });
    }

    const download = req.query.download === '1' || req.query.download === 'true';
    const fileName = document.fileName || path.basename(absolutePath);

    // Re-sniff on the way out rather than trusting the stored value. Rows written
    // before content sniffing existed still carry a client-supplied mime type.
    const sniffed = fileType.sniff(absolutePath);
    const mime = sniffed?.mime || 'application/octet-stream';

    // Only render in the browser for types that cannot execute. Anything else —
    // including anything unrecognised — is forced to download, so a file that
    // slipped through cannot run as script on this origin.
    const inline = !download && fileType.isInlineSafe(mime);

    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(fileName)}"`
    );

    // Stream the file
    const stream = fs.createReadStream(absolutePath);
    stream.on('error', (err) => {
      console.error('File stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'We could not open that file. It may have been moved or removed.' });
      }
    });
    stream.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'We could not open that document. Please try again.' });
  }
});


// List documents for an application
router.get('/:applicationId', async (req, res) => {
  try {
    // Avoid conflict with /file/:documentId — only match UUID-like application ids
    if (req.params.applicationId === 'file') {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    const application = await prisma.application.findUnique({
      where: { id: req.params.applicationId },
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    if (!access.canView(req.user, application)) {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    const documents = await prisma.document.findMany({
      where: { applicationId: req.params.applicationId },
      orderBy: { createdAt: 'asc' },
    });

    // What blocks submission goes first. Creation order put a genuinely optional
    // death certificate above a required affidavit, so somebody working down the
    // list collected the wrong things first.
    res.json({ success: true, data: slots.orderRows(documents) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'We could not load the documents. Please try again.' });
  }
});

// Delete / reset a document
router.delete('/:documentId', async (req, res) => {
  try {
    const document = await prisma.document.findUnique({
      where: { id: req.params.documentId },
      include: { application: true },
    });

    if (!document) {
      return res.status(404).json({ success: false, message: 'We could not find that document.' });
    }

    if (!access.canView(req.user, document.application)) {
      return res.status(404).json({ success: false, message: 'We could not find that document.' });
    }

    // Once submitted, the reviewer must see exactly what was declared. Without
    // this an applicant could strip evidence off an application already in the queue.
    if (document.application.status !== 'DRAFT' && req.user.role !== 'ADMIN') {
      return res.status(400).json({
        success: false,
        message: 'This application has been submitted, so its documents can no longer be changed.',
      });
    }

    if (document.filePath) {
      const absolutePath = path.isAbsolute(document.filePath)
        ? document.filePath
        : path.resolve(process.cwd(), document.filePath);
      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
      }
    }

    await prisma.document.update({
      where: { id: document.id },
      data: {
        fileName: null,
        filePath: null,
        mimeType: null,
        fileSize: null,
        status: 'Pending',
        uploadedAt: null,
      },
    });

    res.json({ success: true, message: 'Document removed' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'We could not remove that document. Please try again.' });
  }
});

module.exports = router;
