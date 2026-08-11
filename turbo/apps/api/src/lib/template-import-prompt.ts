import {
  MAX_PRESENTATION_TEMPLATE_PAGES,
  MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES,
  PRESENTATION_TEMPLATE_CONVERSION_TIMEOUT_SECONDS,
} from "@vm0/api-contracts/contracts/zero-presentation-templates";

export function templateImportPrompt(templateId: string): string {
  return `Import presentation template ${templateId}.

Follow this mechanical pipeline exactly:
1. Create a temporary working directory and download the source:
   WORK_DIR="$(mktemp -d)"
   SOURCE_PATH="$WORK_DIR/source"
   mkdir -p "$WORK_DIR/rendered" "$WORK_DIR/pages" "$WORK_DIR/package"
   zero presentation-template source --id ${templateId} --out "$SOURCE_PATH"
2. Reject a source larger than ${MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES.toString()} bytes. Verify from its magic bytes and zip directory that it is an unencrypted PPTX containing ppt/presentation.xml, then move it to "$WORK_DIR/source.pptx". Never trust only the filename extension.
3. Unzip a read-only copy for XML analysis, then convert the PPTX to "$WORK_DIR/rendered/source.pdf" within ${PRESENTATION_TEMPLATE_CONVERSION_TIMEOUT_SECONDS.toString()} seconds:
   timeout ${PRESENTATION_TEMPLATE_CONVERSION_TIMEOUT_SECONDS.toString()}s soffice -env:UserInstallation=file://"$WORK_DIR/libreoffice-profile" --headless --convert-to pdf --outdir "$WORK_DIR/rendered" "$WORK_DIR/source.pptx"
4. Read the page count with pdfinfo, reject more than ${MAX_PRESENTATION_TEMPLATE_PAGES.toString()} pages, and render ordered PNG files:
   timeout ${PRESENTATION_TEMPLATE_CONVERSION_TIMEOUT_SECONDS.toString()}s pdftoppm -png -r 144 "$WORK_DIR/rendered/source.pdf" "$WORK_DIR/pages/page"
5. Upload all ordered PNG pages with:
   zero presentation-template pages upload --id ${templateId} --dir "$WORK_DIR/pages"
6. Produce exactly these three package files in "$WORK_DIR/package": DESIGN_SYSTEM.md, LAYOUTS.md, and tokens.json.
7. Publish all three together with:
   zero presentation-template publish --id ${templateId} --dir "$WORK_DIR/package"
8. If any step fails, report one of too_many_pages, conversion_timeout, render_failed, analysis_failed, or publish_failed with:
   zero presentation-template fail --id ${templateId} --code <code> --message <message>

Extraction contract:
- Parsed source values override visual estimates. Take colors and fonts from ppt/theme/theme1.xml, slot geometry from ppt/slideLayouts/*.xml, and page dimensions from ppt/presentation.xml instead of estimating them from rendered pixels.
- Describe style, never customer content. Do not copy source titles, names, subjects, numbers, or claims into the package.
- Capture only recurring design rules and elements; omit one-off slide decorations.
- DESIGN_SYSTEM.md, LAYOUTS.md, and tokens.json are an atomic result. Never publish a partial package.

The run has no R2 credentials, bucket names, or storage names. Use only the presentation-template CLI commands above for source, page, and package I/O.`;
}
