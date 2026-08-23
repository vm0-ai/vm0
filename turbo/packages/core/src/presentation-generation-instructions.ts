export const PRESENTATION_IMAGE_BATCH_INSTRUCTION_LINES = [
  "- Use supplied images first. If 1-4 generated images are needed, write an outside-output manifest before HTML: `asset-id<TAB>raw prompt[<TAB>size]`; sizes: 1024x1024, 1536x1024, or 1024x1536.",
  "- Start the batch once with `okou generate image-batch start <manifest.tsv> <state-dir>`, then author the final semantic HTML/CSS/SVG while it runs. No manifest: skip start and wait. The command owns generation settings, concurrency, and retry; never call `okou generate image` directly.",
  "- If a batch started, wait once before verification with `okou generate image-batch wait <state-dir>`, embed the images listed in `<state-dir>/results.tsv`, and keep batch files outside the hosted output.",
] as const;

export const PRESENTATION_STATIC_HTML_INSTRUCTION =
  "- Keep all slides and visible content in index.html; render the first slide without JavaScript, which may only enhance controls, themes, or animation.";
