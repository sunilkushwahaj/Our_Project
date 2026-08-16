Add 4 new tools to this PDF website, following the exact same backend/frontend pattern as merge/split/compress (see AGENTS.md for conventions):

1. **Rotate PDF** — rotate all pages (or a selected page range) by 90°, 180°, or 270°. Use `pdf-lib`'s page.setRotation() method.

2. **Delete Pages** — let the user specify which page numbers to remove (e.g. "2,4,7" or a range like "3-5"), and return a new PDF without those pages. Use `pdf-lib`.

3. **Add Watermark** — let the user type custom watermark text (e.g. "CONFIDENTIAL" or "DRAFT"), choose position (center/diagonal), and apply it as semi-transparent text across all pages. Use `pdf-lib`'s drawText with rotation and opacity.

4. **Add Page Numbers** — stamp page numbers on every page (e.g. "Page 1 of 10"), with an option for position (bottom-center, bottom-right, top-right). Use `pdf-lib`.

For each tool:
- Add a new `POST /api/<tool-name>` backend endpoint in server.js, following the exact same structure as the existing merge/split/compress endpoints — including file validation, try/catch error handling, and scheduling output file auto-delete (~1 hour) as per AGENTS.md.
- Add a matching tool card in the tool grid on the landing page (with its own icon and a distinct soft color tint, consistent with the existing 6 cards).
- Add a matching UI section/tab in the tool workspace area (the tabbed panel with Merge/Split/Compress/etc.) with the correct inputs for that tool (e.g. rotation angle dropdown, page number input, watermark text input).
- Keep the design language (colors, spacing, fonts, button styles) fully consistent with the existing tools — don't introduce new UI patterns.

Do not modify or break any of the existing tools (Merge, Split, Compress, Image to PDF, PDF to Image, Image Converter) while adding these.

Show me the plan first before implementing — I want to confirm the approach before you start writing code.
