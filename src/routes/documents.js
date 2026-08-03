const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();
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
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, JPG, PNG, DOC, DOCX'));
    }
  },
});

router.use(authenticate);

// Upload document for an application
router.post('/:applicationId/upload', upload.single('file'), async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { documentId, type } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const application = await prisma.application.findUnique({
      where: { id: applicationId },
    });

    if (!application) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    if (req.user.role !== 'ADMIN' && application.userId !== req.user.id) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (application.status !== 'DRAFT' && req.user.role !== 'ADMIN') {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'Cannot upload to submitted application' });
    }

    let document;

    if (documentId) {
      // Remove old file if replacing
      const existing = await prisma.document.findUnique({ where: { id: documentId } });
      if (existing?.filePath && fs.existsSync(existing.filePath)) {
        try { fs.unlinkSync(existing.filePath); } catch (_) {}
      }

      document = await prisma.document.update({
        where: { id: documentId },
        data: {
          fileName: req.file.originalname,
          filePath: req.file.path,
          mimeType: req.file.mimetype,
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
          mimeType: req.file.mimetype,
          fileSize: req.file.size,
          status: 'Uploaded',
          uploadedAt: new Date(),
        },
      });
    }

    res.json({
      success: true,
      message: 'Document uploaded successfully',
      data: document,
    });
  } catch (error) {
    console.error(error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ success: false, message: error.message || 'Upload failed' });
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
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    if (req.user.role !== 'ADMIN' && document.application.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
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
    const mime = document.mimeType || 'application/octet-stream';

    res.setHeader('Content-Type', mime);
    res.setHeader(
      'Content-Disposition',
      download
        ? `attachment; filename="${encodeURIComponent(fileName)}"`
        : `inline; filename="${encodeURIComponent(fileName)}"`
    );

    // Stream the file
    const stream = fs.createReadStream(absolutePath);
    stream.on('error', (err) => {
      console.error('File stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Failed to read file' });
      }
    });
    stream.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to retrieve document' });
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
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    if (req.user.role !== 'ADMIN' && application.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const documents = await prisma.document.findMany({
      where: { applicationId: req.params.applicationId },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ success: true, data: documents });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch documents' });
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
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    if (req.user.role !== 'ADMIN' && document.application.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
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
    res.status(500).json({ success: false, message: 'Failed to delete document' });
  }
});

module.exports = router;
