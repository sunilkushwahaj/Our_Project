# PDF Tools Website - Agent Guidelines

## Project overview
A free, no-login web utility site for PDF operations (merge, split, compress,
convert). Similar in spirit to smallpdf.com / ilovepdf.com but simpler and
self-hosted. Revenue model: organic SEO traffic + ads/freemium later. This is
a solo-developer project (owner also runs other products: SlotMate, Ezhog) —
keep everything simple, avoid over-engineering.

## Tech stack (do not change without discussion)
- Backend: Node.js + Express
- PDF operations: `pdf-lib` (merge, split, rotate, page manipulation)
- Image operations: `sharp` (for Image↔PDF tools)
- File uploads: `multer`
- Frontend: plain HTML/CSS/JS (no framework) — keep it in `public/`
- No database required for MVP. Only add one if usage analytics or user
  accounts/premium tiers are explicitly requested.

## Architecture rules
- **Stateless & privacy-first**: uploaded files go to `uploads/`, processed
  files go to `outputs/`. Nothing is stored permanently.
- **Auto-delete**: every output file must be scheduled for deletion
  (~1 hour) after creation. Never skip this when adding a new tool endpoint.
- **No login required** for core tools — keep friction low for SEO traffic.
  Only add auth if a "premium tier" is explicitly being built.
- Each PDF tool = one POST endpoint under `/api/<tool-name>`, following the
  existing pattern in `server.js` (see `/api/merge`, `/api/split`,
  `/api/compress`).
- Validate file type and size (50MB limit currently) on every upload endpoint.
- Wrap all endpoint logic in try/catch; always clean up uploaded temp files
  in both success and error paths.

## Code style
- Keep dependencies minimal — prefer well-known, actively maintained
  libraries over adding new ones for small tasks.
- Comment non-obvious logic (e.g. page-index math, byte-range handling).
- Match the existing code style in `server.js` (async/await, not callbacks
  except where multer/fs require it).
- Frontend: keep it a single `public/index.html` with inline `<style>` and
  `<script>` unless the project explicitly moves to a framework — don't
  introduce React/build tooling unless asked.

## When adding a new tool (e.g. Image to PDF, Watermark, Password protect)
1. Add a new `POST /api/<tool>` route in `server.js` following the existing
   merge/split/compress pattern.
2. Add matching UI card in `public/index.html` (file input + button + result div).
3. Schedule auto-delete for any new output file.
4. Update `README.md`'s tool list.
5. Don't touch unrelated existing endpoints unless fixing a bug in them.

## Known next steps (from planning discussion — pick these up when asked)
- Real image-based compression is weak right now (pdf-lib doesn't
  recompress embedded images). Ghostscript via `child_process` is the
  planned fix — see the comment block at the bottom of `server.js` for the
  exact command before implementing.
- Image to PDF / PDF to Image tools not yet built.
- SEO: eventually each tool needs its own landing page/route
  (`/merge-pdf`, `/split-pdf`, etc.) instead of one single page — not needed
  for early local testing.
- Rate limiting (`express-rate-limit`) needed before any public deployment.

## What NOT to do
- Don't add user accounts, payment integration, or a database unless
  explicitly asked — MVP stays stateless.
- Don't introduce a frontend framework (React/Vue) unless explicitly asked.
- Don't remove the auto-delete/cleanup logic when refactoring.
- Don't silently change the tech stack (e.g. swapping pdf-lib for another
  library) — flag it and ask first if a limitation is hit.
