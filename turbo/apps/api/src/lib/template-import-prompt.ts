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
4. In one bounded extraction pass, normally finishing within five minutes, recover the reusable visual language and original reusable assets. Do not reproduce the source deck and do not run similarity, proof, or rebuild loops. Scripts and thresholds may narrow candidate sets, but you make the final classification from the complete evidence.
5. Build this package in "$WORK_DIR/package":
   SKILL.md
   design-system.md
   color-systems/<token>.css        # only when a colour system was recovered
   assets/identity/*                # only for retained logos or icons
   assets/backgrounds/*             # only for clean reusable backgrounds
   assets/fonts/*                   # only for usable font payloads
   Do not include JSON, LAYOUTS.md, empty directories, placeholders, or intermediate extraction reports.
6. Publish the complete directory atomically with:
   okou presentation-template publish --id ${templateId} --dir "$WORK_DIR/package"
7. If analysis fails, report it with:
   okou presentation-template fail --id ${templateId} --code analysis_failed --message <message>
   If the package was assembled but archive upload or atomic publication fails, use code publish_failed instead.

Extraction contract:
- OOXML is exact structural evidence. Read theme declarations, slide master and layout inheritance, slide size, font declarations, media relationships, and reusable original resources. Prefer these values over estimates from pixels.
- The ordered browser-rendered PNGs are final appearance evidence for the fixed 16:9 vm0 surface. Use them to judge whitespace, density, decoration, image-text relationships, and background effects, not as a replacement for OOXML structure.
- Extract reusable brand marks, logos, icons, colour roles, typography evidence, clean backgrounds, and layout tendencies. Preserve usable original bytes for identity, media, vector, and font assets.
- Describe reusable visual language, never customer content. Do not copy source titles, people, subjects, numbers, conclusions, claims, one-off semantic imagery, or one-off decorations into the package.
- When text or semantic imagery cannot be cleanly separated from flattened pixels, state that limitation in design-system.md. Do not present the result as a clean reusable background.
- Summarize layout observations as prose in design-system.md. They are reference tendencies, not layout IDs, a schema, a required page sequence, or fixed renderer input.
- Keep SKILL.md concise. It must tell a future AI to read design-system.md, inspect relevant assets, and author the final presentation directly as semantic HTML, CSS, and SVG from the new content. There is no slide JSON, tokens.json consumer, JSON-to-HTML step, template renderer, or layout API.
- Recommend CSS Grid or Flexbox for live rows, columns, and text flow when they fit. Reserve absolute positioning mainly for backgrounds, fixed chrome, decoration, and intentional overlays. This is guidance, not a compulsory renderer policy.
- Background images are optional visual materials rather than predeclared layouts. New text, charts, tables, labels, and diagrams remain live HTML or SVG.
- SKILL.md, design-system.md, and every retained asset form one atomic package. Never publish a partial package.

The run has no R2 credentials, bucket names, storage names, or direct object keys. Use only the presentation-template CLI commands above for source, page, and package I/O.`;
}
