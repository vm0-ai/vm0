export const PRESENTATION_IMAGE_BATCH_INSTRUCTION =
  "- Image workflow: use supplied images first; only for 1-4 generated images, write an outside-output TSV (`asset-id<TAB>raw prompt[<TAB>size]`; size 1024x1024, 1536x1024, or 1024x1536), then `okou generate image-batch start <manifest.tsv> <state-dir>` once → author the deck while it runs → `okou generate image-batch wait <state-dir>` once before verification → embed the images listed in `<state-dir>/results.tsv`; with no manifest skip this workflow, keep its state outside the hosted output, let the command own generation settings/concurrency/retry, and never call `okou generate image` directly.";

export const PRESENTATION_STATIC_HTML_INSTRUCTION =
  "- Keep all slides and visible content in index.html; render the first slide without JavaScript, which may only enhance controls, themes, or animation.";
