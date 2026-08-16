# PDF Tools - Starter

## Setup
```bash
cd pdf-tool
npm install
npm start
```
Open http://localhost:3000

## What's included
- **Merge** (`POST /api/merge`) - combine 2+ PDFs into one
- **Split** (`POST /api/split`) - extract a page range, or split every page into a separate file
- **Compress** (`POST /api/compress`) - re-saves PDF with object streams (helps with bloated PDFs, but not real image recompression - see note below)
- Simple frontend in `public/index.html` to test all 3 tools in browser
- Auto-delete: output files delete themselves after 1 hour (privacy)

## Next steps to make this production-ready

1. **Real compression** - `pdf-lib` alone won't shrink image-heavy PDFs much. Install Ghostscript on your server and shell out to it from Node (see comment at bottom of `server.js` for the exact command). This is what actually gives the "60% smaller" results users expect.

2. **Image ↔ PDF tools** - add using `sharp` (for image processing) + `pdf-lib` (to embed images into a PDF page).

3. **File size limits** - currently capped at 50MB per file in multer config. Adjust based on your server's disk/RAM.

4. **Deploy** - any VPS with Node 18+ works (DigitalOcean, Hetzner, Railway). Make sure the `uploads/` and `outputs/` folders have write permissions and enough disk space, since files sit there temporarily.

5. **SEO landing pages** - right now everything is one page. For traffic, split into separate routes/pages per tool: `/merge-pdf`, `/split-pdf`, `/compress-pdf` — each with its own H1, meta description, and this same upload widget embedded.

6. **Rate limiting** - add `express-rate-limit` before going live, so one user can't hammer your server with huge files repeatedly.

## Folder structure
```
pdf-tool/
├── server.js          # main backend
├── package.json
├── public/
│   └── index.html      # test frontend
├── uploads/             # temp uploaded files (auto-cleaned)
└── outputs/             # processed files (auto-deleted after 1hr)
```
