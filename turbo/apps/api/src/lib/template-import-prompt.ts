import {
  MAX_PRESENTATION_TEMPLATE_PAGES,
  MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";

export function templateImportPrompt(templateId: string): string {
  return `Import presentation template ${templateId}.

Follow this pipeline exactly:
1. Create a temporary working directory and download the committed inputs:
   WORK_DIR="$(mktemp -d)"
   mkdir -p "$WORK_DIR/pages" "$WORK_DIR/package" "$WORK_DIR/ooxml"
   okou presentation-template source --id ${templateId} --out "$WORK_DIR/source.pptx"
   okou presentation-template pages pull --id ${templateId} --dir "$WORK_DIR/pages"
2. Treat the ordered PNG files as the visual appearance vm0 showed to the user. They are already rendered from the browser preview tree. Never render, convert, replace, reorder, or upload page images, and do not create intermediate visual files.
3. Verify that source.pptx is at most ${MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES.toString()} bytes, is an unencrypted OOXML presentation, and has the same slide count as the contiguous ordered page PNGs. Reject more than ${MAX_PRESENTATION_TEMPLATE_PAGES.toString()} slides. Extract a read-only copy into "$WORK_DIR/ooxml" for structural analysis.
4. Produce exactly these three package files in "$WORK_DIR/package": DESIGN_SYSTEM.md, LAYOUTS.md, and tokens.json.
5. Publish all three together with:
   okou presentation-template publish --id ${templateId} --dir "$WORK_DIR/package"
6. If analysis fails, report it with:
   okou presentation-template fail --id ${templateId} --code analysis_failed --message <message>
   If all files were produced but atomic publication fails, use code publish_failed instead.

Extraction contract:
- Parsed OOXML values override visual estimates. Read exact colors and fonts from ppt/theme/*.xml, slot geometry from ppt/slideLayouts/*.xml, master relationships from ppt/slideMasters/*.xml, and slide size from ppt/presentation.xml.
- The ordered browser-rendered PNGs are the visual reference for the fixed 16:9 vm0 surface. Use them to understand the appearance vm0 persisted, not as a replacement for OOXML structure.
- Describe style, never customer content. Do not copy source titles, names, subjects, numbers, or claims into the package.
- Capture recurring design rules and elements only; omit one-off slide content and decorations.
- DESIGN_SYSTEM.md, LAYOUTS.md, and tokens.json are one atomic result. Never publish a partial package.

The run has no R2 credentials, bucket names, storage names, or direct object keys. Use only the presentation-template CLI commands above for source, page, and package I/O.`;
}
