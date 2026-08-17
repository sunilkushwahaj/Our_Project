const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { PDFDocument, degrees, StandardFonts, rgb } = require('pdf-lib');
const sharp = require('sharp');
const { createCanvas } = require('@napi-rs/canvas');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Setup folders ----
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(cors());
app.use(express.static('public'));
app.use('/outputs', express.static(OUTPUT_DIR, {
  setHeaders: (res, filePath) => {
    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }
}));

// ---- Multer config (file upload) ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + '-' + file.originalname.replace(/\s+/g, '_'));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF or image files are allowed'));
    }
  }
});

// ---- Helper: auto-delete a file after delay (privacy) ----
function scheduleDelete(filePath, delayMs = 60 * 60 * 1000) { // default 1 hour
  setTimeout(() => {
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') console.error('Delete failed:', filePath, err.message);
    });
  }, delayMs);
}

// =========================================================
// 1. MERGE PDF - combine multiple PDFs into one
// =========================================================
app.post('/api/merge', upload.array('files', 20), async (req, res) => {
  const uploadedFiles = req.files;
  try {
    if (!uploadedFiles || uploadedFiles.length < 2) {
      return res.status(400).json({ error: 'Upload at least 2 PDF files to merge' });
    }

    const mergedPdf = await PDFDocument.create();

    for (const file of uploadedFiles) {
      const fileBytes = fs.readFileSync(file.path);
      const pdf = await PDFDocument.load(fileBytes);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }

    const mergedBytes = await mergedPdf.save();
    const outputFilename = `merged-${Date.now()}.pdf`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    fs.writeFileSync(outputPath, mergedBytes);

    // cleanup uploaded originals immediately, output after 1 hour
    uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));
    scheduleDelete(outputPath);

    res.json({ success: true, downloadUrl: `/outputs/${outputFilename}` });
  } catch (err) {
    console.error(err);
    if (uploadedFiles) uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));
    res.status(500).json({ error: 'Failed to merge PDFs: ' + err.message });
  }
});

// =========================================================
// 2. SPLIT PDF - extract page range or split into individual pages
// =========================================================
app.post('/api/split', upload.single('file'), async (req, res) => {
  const uploadedFile = req.file;
  try {
    if (!uploadedFile) return res.status(400).json({ error: 'Upload a PDF file' });

    const { mode, startPage, endPage } = req.body; // mode: 'range' | 'all'
    const fileBytes = fs.readFileSync(uploadedFile.path);
    const srcPdf = await PDFDocument.load(fileBytes);
    const totalPages = srcPdf.getPageCount();

    const outputFiles = [];

    if (mode === 'all') {
      // one PDF per page
      for (let i = 0; i < totalPages; i++) {
        const newPdf = await PDFDocument.create();
        const [copiedPage] = await newPdf.copyPages(srcPdf, [i]);
        newPdf.addPage(copiedPage);
        const bytes = await newPdf.save();
        const filename = `split-page-${i + 1}-${Date.now()}.pdf`;
        const outPath = path.join(OUTPUT_DIR, filename);
        fs.writeFileSync(outPath, bytes);
        scheduleDelete(outPath);
        outputFiles.push(`/outputs/${filename}`);
      }
    } else {
      // extract a specific page range
      const start = Math.max(0, parseInt(startPage || 1, 10) - 1);
      const end = Math.min(totalPages - 1, parseInt(endPage || totalPages, 10) - 1);

      if (start > end) {
        fs.unlink(uploadedFile.path, () => {});
        return res.status(400).json({ error: 'Invalid page range' });
      }

      const pageIndices = [];
      for (let i = start; i <= end; i++) pageIndices.push(i);

      const newPdf = await PDFDocument.create();
      const copiedPages = await newPdf.copyPages(srcPdf, pageIndices);
      copiedPages.forEach(page => newPdf.addPage(page));

      const bytes = await newPdf.save();
      const filename = `split-range-${Date.now()}.pdf`;
      const outPath = path.join(OUTPUT_DIR, filename);
      fs.writeFileSync(outPath, bytes);
      scheduleDelete(outPath);
      outputFiles.push(`/outputs/${filename}`);
    }

    fs.unlink(uploadedFile.path, () => {});
    res.json({ success: true, files: outputFiles, totalPages });
  } catch (err) {
    console.error(err);
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    res.status(500).json({ error: 'Failed to split PDF: ' + err.message });
  }
});

// =========================================================
// 3. COMPRESS PDF - reduce file size
// =========================================================
app.post('/api/compress', upload.single('file'), async (req, res) => {
  const uploadedFile = req.file;
  try {
    if (!uploadedFile) return res.status(400).json({ error: 'Upload a PDF file' });

    const originalSize = uploadedFile.size;
    const fileBytes = fs.readFileSync(uploadedFile.path);
    const pdf = await PDFDocument.load(fileBytes);

    const compressedBytes = await pdf.save({
      useObjectStreams: true,
      addDefaultPage: false,
    });

    const filename = `compressed-${Date.now()}.pdf`;
    const outputPath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(outputPath, compressedBytes);
    scheduleDelete(outputPath);

    fs.unlink(uploadedFile.path, () => {});

    res.json({
      success: true,
      downloadUrl: `/outputs/${filename}`,
      originalSize,
      compressedSize: compressedBytes.length,
      savedPercent: (((originalSize - compressedBytes.length) / originalSize) * 100).toFixed(1)
    });
  } catch (err) {
    console.error(err);
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    res.status(500).json({ error: 'Failed to compress PDF: ' + err.message });
  }
});

// =========================================================
// 4. IMAGE TO PDF - convert images (JPG/PNG/WebP) to single PDF
// =========================================================
app.post('/api/image-to-pdf', upload.array('images', 30), async (req, res) => {
  const uploadedFiles = req.files;
  try {
    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'Upload at least 1 image file' });
    }

    const pdfDoc = await PDFDocument.create();

    for (const file of uploadedFiles) {
      const fileBytes = fs.readFileSync(file.path);
      const metadata = await sharp(file.path).metadata();

      let embeddedImage;
      if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
        embeddedImage = await pdfDoc.embedJpg(fileBytes);
      } else if (metadata.format === 'png') {
        embeddedImage = await pdfDoc.embedPng(fileBytes);
      } else {
        // Convert webp/gif/bmp to png buffer via sharp
        const pngBuffer = await sharp(file.path).toFormat('png').toBuffer();
        embeddedImage = await pdfDoc.embedPng(pngBuffer);
      }

      const page = pdfDoc.addPage([embeddedImage.width, embeddedImage.height]);
      page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: embeddedImage.width,
        height: embeddedImage.height,
      });
    }

    const pdfBytes = await pdfDoc.save();
    const outputFilename = `image-to-pdf-${Date.now()}.pdf`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    fs.writeFileSync(outputPath, pdfBytes);

    uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));
    scheduleDelete(outputPath);

    res.json({ success: true, downloadUrl: `/outputs/${outputFilename}` });
  } catch (err) {
    console.error(err);
    if (uploadedFiles) uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));
    res.status(500).json({ error: 'Failed to convert images to PDF: ' + err.message });
  }
});

// =========================================================
// 5. PDF TO IMAGE - convert each PDF page into PNG or JPG image
// =========================================================
app.post('/api/pdf-to-image', upload.single('file'), async (req, res) => {
  const uploadedFile = req.file;
  try {
    if (!uploadedFile) return res.status(400).json({ error: 'Upload a PDF file' });

    const format = (req.body.format || 'png').toLowerCase(); // 'png' or 'jpg'

    const data = new Uint8Array(fs.readFileSync(uploadedFile.path));
    const loadingTask = pdfjs.getDocument({
      data,
      disableFontFace: true,
      verbosity: 0
    });
    const pdfDoc = await loadingTask.promise;
    const totalPages = pdfDoc.numPages;
    const outputFiles = [];

    for (let i = 1; i <= totalPages; i++) {
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvasFactory = new NodeCanvasFactory();
      const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);

      const renderContext = {
        canvasContext: canvasAndContext.context,
        viewport,
        canvasFactory
      };

      await page.render(renderContext).promise;
      let imgBuffer = canvasAndContext.canvas.toBuffer('image/png');

      if (format === 'jpg' || format === 'jpeg') {
        imgBuffer = await sharp(imgBuffer).jpeg({ quality: 90 }).toBuffer();
      }

      const ext = (format === 'jpg' || format === 'jpeg') ? 'jpg' : 'png';
      const filename = `pdf-page-${i}-${Date.now()}.${ext}`;
      const outPath = path.join(OUTPUT_DIR, filename);
      fs.writeFileSync(outPath, imgBuffer);
      scheduleDelete(outPath);
      outputFiles.push(`/outputs/${filename}`);
    }

    fs.unlink(uploadedFile.path, () => {});
    res.json({ success: true, files: outputFiles, totalPages });
  } catch (err) {
    console.error(err);
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    res.status(500).json({ error: 'Failed to convert PDF to images: ' + err.message });
  }
});

// =========================================================
// 6. JPG ↔ PNG IMAGE CONVERTER - convert image format
// =========================================================
app.post('/api/convert-image', upload.single('file'), async (req, res) => {
  const uploadedFile = req.file;
  try {
    if (!uploadedFile) return res.status(400).json({ error: 'Upload an image file' });

    const targetFormat = (req.body.targetFormat || 'png').toLowerCase(); // 'png' | 'jpg' | 'webp'
    let sharpInstance = sharp(uploadedFile.path);

    let outputBuffer;
    let ext;
    if (targetFormat === 'jpg' || targetFormat === 'jpeg') {
      outputBuffer = await sharpInstance.jpeg({ quality: 90 }).toBuffer();
      ext = 'jpg';
    } else if (targetFormat === 'webp') {
      outputBuffer = await sharpInstance.webp({ quality: 90 }).toBuffer();
      ext = 'webp';
    } else {
      outputBuffer = await sharpInstance.png().toBuffer();
      ext = 'png';
    }

    const filename = `converted-${Date.now()}.${ext}`;
    const outputPath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(outputPath, outputBuffer);

    fs.unlink(uploadedFile.path, () => {});
    scheduleDelete(outputPath);

    res.json({ success: true, downloadUrl: `/outputs/${filename}` });
  } catch (err) {
    console.error(err);
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    res.status(500).json({ error: 'Failed to convert image format: ' + err.message });
  }
});

// ---- Helper: parse page string like "1-3, 5, 7-9" into Set of 0-based page indices ----
function parsePageIndices(inputStr, totalPages) {
  if (!inputStr || typeof inputStr !== 'string') return new Set();
  const indices = new Set();
  const parts = inputStr.split(',').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-').map(s => s.trim());
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) continue;
      const min = Math.max(1, Math.min(start, end));
      const max = Math.min(totalPages, Math.max(start, end));
      for (let i = min; i <= max; i++) {
        indices.add(i - 1);
      }
    } else {
      const pageNum = parseInt(part, 10);
      if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
        indices.add(pageNum - 1);
      }
    }
  }
  return indices;
}

// =========================================================
// 7. ROTATE PDF - rotate pages by 90, 180, or 270 degrees
// =========================================================
app.post('/api/rotate', upload.single('file'), async (req, res) => {
  const uploadedFile = req.file;
  try {
    if (!uploadedFile) return res.status(400).json({ error: 'Upload a PDF file' });

    const angle = parseInt(req.body.angle || '90', 10);
    if (![90, 180, 270].includes(angle)) {
      fs.unlink(uploadedFile.path, () => {});
      return res.status(400).json({ error: 'Rotation angle must be 90, 180, or 270 degrees' });
    }

    const pageScope = req.body.pageScope || 'all'; // 'all' | 'custom'
    const customPagesStr = req.body.customPages || '';

    const fileBytes = fs.readFileSync(uploadedFile.path);
    const pdfDoc = await PDFDocument.load(fileBytes);
    const totalPages = pdfDoc.getPageCount();

    let targetIndices = new Set();
    if (pageScope === 'custom' && customPagesStr.trim()) {
      targetIndices = parsePageIndices(customPagesStr, totalPages);
    } else {
      for (let i = 0; i < totalPages; i++) targetIndices.add(i);
    }

    if (targetIndices.size === 0) {
      fs.unlink(uploadedFile.path, () => {});
      return res.status(400).json({ error: 'No valid target pages selected to rotate' });
    }

    targetIndices.forEach(idx => {
      const page = pdfDoc.getPage(idx);
      const currentRotation = page.getRotation().angle;
      page.setRotation(degrees((currentRotation + angle) % 360));
    });

    const rotatedBytes = await pdfDoc.save();
    const outputFilename = `rotated-${Date.now()}.pdf`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    fs.writeFileSync(outputPath, rotatedBytes);

    fs.unlink(uploadedFile.path, () => {});
    scheduleDelete(outputPath);

    res.json({ success: true, downloadUrl: `/outputs/${outputFilename}` });
  } catch (err) {
    console.error(err);
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    res.status(500).json({ error: 'Failed to rotate PDF: ' + err.message });
  }
});

// =========================================================
// 8. DELETE PAGES - remove specific page numbers or ranges
// =========================================================
app.post('/api/delete-pages', upload.single('file'), async (req, res) => {
  const uploadedFile = req.file;
  try {
    if (!uploadedFile) return res.status(400).json({ error: 'Upload a PDF file' });

    const pagesToDeleteStr = req.body.pagesToDelete || '';
    const fileBytes = fs.readFileSync(uploadedFile.path);
    const srcPdf = await PDFDocument.load(fileBytes);
    const totalPages = srcPdf.getPageCount();

    const deleteIndices = parsePageIndices(pagesToDeleteStr, totalPages);

    if (!deleteIndices || deleteIndices.size === 0) {
      fs.unlink(uploadedFile.path, () => {});
      return res.status(400).json({ error: 'Please specify valid page numbers to delete (e.g. 2, 4, 7-10)' });
    }

    if (deleteIndices.size >= totalPages) {
      fs.unlink(uploadedFile.path, () => {});
      return res.status(400).json({ error: 'Cannot delete all pages from the PDF' });
    }

    const keepIndices = [];
    for (let i = 0; i < totalPages; i++) {
      if (!deleteIndices.has(i)) {
        keepIndices.push(i);
      }
    }

    const newPdf = await PDFDocument.create();
    const copiedPages = await newPdf.copyPages(srcPdf, keepIndices);
    copiedPages.forEach(page => newPdf.addPage(page));

    const newBytes = await newPdf.save();
    const outputFilename = `deleted-pages-${Date.now()}.pdf`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    fs.writeFileSync(outputPath, newBytes);

    fs.unlink(uploadedFile.path, () => {});
    scheduleDelete(outputPath);

    res.json({
      success: true,
      downloadUrl: `/outputs/${outputFilename}`,
      remainingPages: keepIndices.length,
      deletedCount: deleteIndices.size
    });
  } catch (err) {
    console.error(err);
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    res.status(500).json({ error: 'Failed to delete pages from PDF: ' + err.message });
  }
});

// =========================================================
// 9. ADD WATERMARK - add custom text watermark across pages
// =========================================================
app.post('/api/watermark', upload.single('file'), async (req, res) => {
  const uploadedFile = req.file;
  try {
    if (!uploadedFile) return res.status(400).json({ error: 'Upload a PDF file' });

    const watermarkText = (req.body.text || 'CONFIDENTIAL').trim();
    if (!watermarkText) {
      fs.unlink(uploadedFile.path, () => {});
      return res.status(400).json({ error: 'Watermark text cannot be empty' });
    }

    const position = req.body.position || 'diagonal'; // 'diagonal' | 'center'
    const opacity = Math.max(0.05, Math.min(1.0, parseFloat(req.body.opacity || '0.3')));
    const fontSize = parseInt(req.body.fontSize || '48', 10);

    const fileBytes = fs.readFileSync(uploadedFile.path);
    const pdfDoc = await PDFDocument.load(fileBytes);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();

    const textWidth = font.widthOfTextAtSize(watermarkText, fontSize);
    const textHeight = font.heightAtSize(fontSize);

    pages.forEach(page => {
      const { width, height } = page.getSize();

      let x = (width - textWidth) / 2;
      let y = (height - textHeight) / 2;
      let rotationAngle = 0;

      if (position === 'diagonal') {
        rotationAngle = 45;
        const rad = (45 * Math.PI) / 180;
        const boundingW = textWidth * Math.cos(rad) + textHeight * Math.sin(rad);
        const boundingH = textWidth * Math.sin(rad) + textHeight * Math.cos(rad);
        x = (width - boundingW) / 2;
        y = (height - boundingH) / 2 + (textWidth * Math.sin(rad)) / 2;
      }

      page.drawText(watermarkText, {
        x: Math.max(10, x),
        y: Math.max(10, y),
        size: fontSize,
        font,
        color: rgb(0.5, 0.5, 0.5),
        opacity,
        rotate: degrees(rotationAngle),
      });
    });

    const watermarkedBytes = await pdfDoc.save();
    const outputFilename = `watermarked-${Date.now()}.pdf`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    fs.writeFileSync(outputPath, watermarkedBytes);

    fs.unlink(uploadedFile.path, () => {});
    scheduleDelete(outputPath);

    res.json({ success: true, downloadUrl: `/outputs/${outputFilename}` });
  } catch (err) {
    console.error(err);
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    res.status(500).json({ error: 'Failed to add watermark: ' + err.message });
  }
});

// =========================================================
// 10. ADD PAGE NUMBERS - stamp page numbers on every page
// =========================================================
app.post('/api/page-numbers', upload.single('file'), async (req, res) => {
  const uploadedFile = req.file;
  try {
    if (!uploadedFile) return res.status(400).json({ error: 'Upload a PDF file' });

    const position = req.body.position || 'bottom-center'; // 'bottom-center' | 'bottom-right' | 'top-right'
    const format = req.body.format || 'Page {n} of {total}';

    const fileBytes = fs.readFileSync(uploadedFile.path);
    const pdfDoc = await PDFDocument.load(fileBytes);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    const totalPages = pages.length;
    const fontSize = 10;
    const margin = 20;

    pages.forEach((page, i) => {
      const pageNum = i + 1;
      const text = format
        .replace('{n}', pageNum)
        .replace('{total}', totalPages);

      const textWidth = font.widthOfTextAtSize(text, fontSize);
      const textHeight = font.heightAtSize(fontSize);
      const { width, height } = page.getSize();

      let x = (width - textWidth) / 2;
      let y = margin;

      if (position === 'bottom-right') {
        x = width - textWidth - margin;
        y = margin;
      } else if (position === 'top-right') {
        x = width - textWidth - margin;
        y = height - margin - textHeight;
      } else { // 'bottom-center'
        x = (width - textWidth) / 2;
        y = margin;
      }

      page.drawText(text, {
        x,
        y,
        size: fontSize,
        font,
        color: rgb(0.2, 0.2, 0.2),
      });
    });

    const numberedBytes = await pdfDoc.save();
    const outputFilename = `numbered-${Date.now()}.pdf`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    fs.writeFileSync(outputPath, numberedBytes);

    fs.unlink(uploadedFile.path, () => {});
    scheduleDelete(outputPath);

    res.json({ success: true, downloadUrl: `/outputs/${outputFilename}` });
  } catch (err) {
    console.error(err);
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    res.status(500).json({ error: 'Failed to add page numbers: ' + err.message });
  }
});

// ---- Error handler for multer errors ----
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message.includes('Only PDF')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`PDF Tool server running on http://localhost:${PORT}`);
});
