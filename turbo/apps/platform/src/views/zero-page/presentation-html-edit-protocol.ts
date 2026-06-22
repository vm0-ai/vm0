import type { PresentationSpeakerNotesPatch } from "@vm0/api-contracts/contracts/zero-host";

const EDITABLE_SELECTOR = '[data-vm0-editable="text"]';
const METADATA_SCRIPT_ID = "vm0-deck-metadata";
const SLIDE_SELECTORS = [
  "[data-vm0-slide]",
  "[data-slide]",
  "[data-slide-index]",
  "[data-page]",
  ".ppt-slide",
  ".presentation-slide",
  ".deck-slide",
  ".slide-page",
  ".slide",
  "section",
] as const;
const FALLBACK_EDITABLE_SELECTOR =
  "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,td,th,span,div";
const UNSAFE_PREVIEW_URL_PROTOCOLS = [
  "data:",
  "javascript:",
  "vbscript:",
] as const;
const THEME_SCRIPT_VARIABLES = {
  fontMap: "FONTS",
  monoPaletteMap: "MONO",
  vibrantPaletteMap: "VIB",
} as const;
const THEME_SWITCHER_SELECT_IDS = {
  font: "swFont",
  palette: "swPal",
} as const;

export interface PresentationEditBlock {
  readonly editId: string;
  readonly slideId: string;
  readonly tagName: string;
  readonly text: string;
}

export interface PresentationSlideDraft {
  readonly id: string;
  readonly notes: string;
  readonly title: string;
}

export interface PresentationEditDraft {
  readonly blocks: readonly PresentationEditBlock[];
  readonly html: string;
  readonly slides: readonly PresentationSlideDraft[];
}

interface DeckMetadataSlide {
  readonly speakerNotes?: string;
}

interface DeckMetadata {
  readonly editProtocolVersion?: number;
  readonly kind?: string;
  readonly slides?: Record<string, DeckMetadataSlide>;
}

interface MutableDeckMetadata {
  editProtocolVersion?: number;
  kind?: string;
  slides?: Record<string, { speakerNotes?: string }>;
}

type PresentationPalette = readonly [
  bg: string,
  surface: string,
  ink: string,
  soft: string,
  placeholder: string,
  accents: readonly [string, string, string, string],
];

type PresentationFontPair = readonly [display: string, body: string];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDeckMetadata(doc: Document): DeckMetadata {
  const script = doc.getElementById(METADATA_SCRIPT_ID);
  if (!script?.textContent) {
    return {};
  }
  const parsed: unknown = JSON.parse(script.textContent);
  if (!isRecord(parsed)) {
    return {};
  }
  const slidesValue = parsed.slides;
  const slides: Record<string, DeckMetadataSlide> = {};
  if (isRecord(slidesValue)) {
    for (const [slideId, value] of Object.entries(slidesValue)) {
      if (!isRecord(value)) {
        continue;
      }
      const notes = value.speakerNotes;
      slides[slideId] =
        typeof notes === "string" ? { speakerNotes: notes } : {};
    }
  }
  return {
    editProtocolVersion:
      typeof parsed.editProtocolVersion === "number"
        ? parsed.editProtocolVersion
        : undefined,
    kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
    slides,
  };
}

function serializeDoc(doc: Document): string {
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function slideIdForElement(slide: Element, index: number): string {
  return slide instanceof HTMLElement
    ? (slide.dataset.slideId ?? `slide-${index + 1}`)
    : `slide-${index + 1}`;
}

function editIdForElement(editable: Element, index: number): string | null {
  if (!(editable instanceof HTMLElement)) {
    return `text-${index + 1}`;
  }
  return (
    editable.dataset.vm0EditId ??
    editable.dataset.editId ??
    editable.dataset.vm0NodeId ??
    editable.dataset.nodeId ??
    `text-${index + 1}`
  );
}

function ensureEditIdForElement(editable: Element, index: number): string {
  const editId = editIdForElement(editable, index) ?? `text-${index + 1}`;
  if (editable instanceof HTMLElement && !editable.dataset.vm0EditId) {
    editable.dataset.vm0EditId = editId;
  }
  return editId;
}

function slideTitle(slide: Element, fallback: string): string {
  const firstEditable =
    slide.querySelector(EDITABLE_SELECTOR) ??
    selectEditableElements(slide)[0] ??
    null;
  const text = firstEditable?.textContent?.trim();
  return text ? text.slice(0, 80) : fallback;
}

function selectSlideElements(doc: Document): Element[] {
  for (const selector of SLIDE_SELECTORS) {
    const slides = Array.from(doc.querySelectorAll(selector));
    if (slides.length > 0) {
      return slides;
    }
  }
  return doc.body ? [doc.body] : [];
}

function hasUsefulText(element: Element): boolean {
  return Boolean(element.textContent?.trim());
}

function isLeafTextElement(element: Element): boolean {
  return !Array.from(element.children).some((child) => {
    return child.matches(FALLBACK_EDITABLE_SELECTOR) && hasUsefulText(child);
  });
}

function selectEditableElements(slide: Element): Element[] {
  const protocolEditables = Array.from(
    slide.querySelectorAll(EDITABLE_SELECTOR),
  );
  if (protocolEditables.length > 0) {
    return protocolEditables;
  }
  return Array.from(slide.querySelectorAll(FALLBACK_EDITABLE_SELECTOR)).filter(
    (element) => {
      return hasUsefulText(element) && isLeafTextElement(element);
    },
  );
}

export function parsePresentationEditDraft(
  html: string,
): PresentationEditDraft {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const metadata = parseDeckMetadata(doc);
  const slideElements = selectSlideElements(doc);
  const slides = slideElements.map((slide, index): PresentationSlideDraft => {
    const id = slideIdForElement(slide, index);
    return {
      id,
      notes: metadata.slides?.[id]?.speakerNotes ?? "",
      title: slideTitle(slide, `Slide ${index + 1}`),
    };
  });
  const blocks = slideElements.flatMap(
    (slide, slideIndex): PresentationEditBlock[] => {
      const slideId = slideIdForElement(slide, slideIndex);
      return selectEditableElements(slide).map(
        (editable, blockIndex): PresentationEditBlock => {
          const editId = ensureEditIdForElement(editable, blockIndex);
          return {
            editId,
            slideId,
            tagName: editable.tagName.toLowerCase(),
            text: editable.textContent ?? "",
          };
        },
      );
    },
  );
  return { blocks, html: serializeDoc(doc), slides };
}

function findSlide(doc: Document, slideId: string): Element | null {
  return (
    selectSlideElements(doc).find((slide, index) => {
      return slideIdForElement(slide, index) === slideId;
    }) ?? null
  );
}

function findEditable(slide: Element, editId: string): Element | null {
  return (
    selectEditableElements(slide).find((editable, index) => {
      return editIdForElement(editable, index) === editId;
    }) ?? null
  );
}

function ensureMetadataScript(doc: Document): HTMLScriptElement {
  const existing = doc.getElementById(METADATA_SCRIPT_ID);
  if (existing instanceof HTMLScriptElement) {
    existing.type = "application/json";
    return existing;
  }
  const script = doc.createElement("script");
  script.type = "application/json";
  script.id = METADATA_SCRIPT_ID;
  doc.body.append(script);
  return script;
}

function sanitizePreviewTree(root: ParentNode): void {
  for (const element of Array.from(
    root.querySelectorAll("script,noscript,iframe,object,embed"),
  )) {
    element.remove();
  }
  for (const meta of Array.from(root.querySelectorAll("meta[http-equiv]"))) {
    if (meta.getAttribute("http-equiv")?.toLowerCase() === "refresh") {
      meta.remove();
    }
  }
  for (const element of Array.from(root.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        ((name === "href" ||
          name === "src" ||
          name === "srcdoc" ||
          name === "xlink:href") &&
          hasUnsafePreviewUrlProtocol(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function isUnsafePreviewUrlProtocol(protocol: string): boolean {
  return (
    protocol === "data:" ||
    protocol === "javascript:" ||
    protocol === "vbscript:"
  );
}

function hasUnsafePreviewUrlProtocol(value: string): boolean {
  // Strip ASCII control characters and whitespace to normalise obfuscated
  // schemes such as "j a v a s c r i p t:" or "java\x00script:".
  let compact = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && code > 0x20 && code !== 0x7f) {
      compact += char;
    }
  }
  compact = compact.toLowerCase();
  if (
    UNSAFE_PREVIEW_URL_PROTOCOLS.some((protocol) => {
      return compact.startsWith(protocol);
    })
  ) {
    return true;
  }
  if (!URL.canParse(value, "https://vm0.invalid/")) {
    return false;
  }
  const protocol = new URL(
    value,
    "https://vm0.invalid/",
  ).protocol.toLowerCase();
  return isUnsafePreviewUrlProtocol(protocol);
}

function sanitizePreviewDocument(doc: Document): void {
  sanitizePreviewTree(doc);
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content =
    "script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'";
  doc.head.prepend(csp);
}

function extractVariableObjectText(
  scriptText: string,
  variableName: string,
): string | null {
  const pattern =
    variableName === THEME_SCRIPT_VARIABLES.monoPaletteMap
      ? /\bvar\s+MONO\s*=\s*(\{[\s\S]*?\});/
      : variableName === THEME_SCRIPT_VARIABLES.vibrantPaletteMap
        ? /\bvar\s+VIB\s*=\s*(\{[\s\S]*?\});/
        : variableName === THEME_SCRIPT_VARIABLES.fontMap
          ? /\bvar\s+FONTS\s*=\s*(\{[\s\S]*?\});/
          : null;
  const match = pattern?.exec(scriptText);
  if (!match?.[1]) {
    return null;
  }
  return match[1];
}

function extractPaletteMap(
  scriptText: string,
  variableName: string,
): Record<string, PresentationPalette> {
  const objectText = extractVariableObjectText(scriptText, variableName);
  if (!objectText) {
    return {};
  }
  const paletteMap: Record<string, PresentationPalette> = {};
  const paletteEntryPattern =
    /"([^"]+)"\s*:\s*\[\s*"(#[\da-f]{6})"\s*,\s*"(#[\da-f]{6})"\s*,\s*"(#[\da-f]{6})"\s*,\s*"(#[\da-f]{6})"\s*,\s*"(#[\da-f]{6})"\s*,\s*\[\s*"(#[\da-f]{6})"\s*,\s*"(#[\da-f]{6})"\s*,\s*"(#[\da-f]{6})"\s*,\s*"(#[\da-f]{6})"\s*\]\s*\]/gi;
  for (const match of objectText.matchAll(paletteEntryPattern)) {
    const [
      ,
      name,
      bg,
      surface,
      ink,
      soft,
      placeholder,
      accent,
      support1,
      support2,
      support3,
    ] = match;
    if (
      name &&
      bg &&
      surface &&
      ink &&
      soft &&
      placeholder &&
      accent &&
      support1 &&
      support2 &&
      support3
    ) {
      paletteMap[name] = [
        bg,
        surface,
        ink,
        soft,
        placeholder,
        [accent, support1, support2, support3],
      ];
    }
  }
  return paletteMap;
}

function extractFontMap(
  scriptText: string,
  variableName: string,
): Record<string, PresentationFontPair> {
  const objectText = extractVariableObjectText(scriptText, variableName);
  if (!objectText) {
    return {};
  }
  const fontMap: Record<string, PresentationFontPair> = {};
  const fontEntryPattern =
    /"([^"]+)"\s*:\s*\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g;
  for (const match of objectText.matchAll(fontEntryPattern)) {
    const [, name, display, body] = match;
    if (name && display?.trim() && body?.trim()) {
      fontMap[name] = [display, body];
    }
  }
  return fontMap;
}

const SW_PAL_GET_BY_ID_PATTERN =
  /\b([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\(\s*(['"])swPal\2\s*\)/g;
const SW_FONT_GET_BY_ID_PATTERN =
  /\b([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\(\s*(['"])swFont\2\s*\)/g;
const SW_PAL_QUERY_SELECTOR_PATTERN =
  /\b([A-Za-z_$][\w$]*)\s*=\s*document\.querySelector\(\s*(['"])#swPal\2\s*\)/g;
const SW_FONT_QUERY_SELECTOR_PATTERN =
  /\b([A-Za-z_$][\w$]*)\s*=\s*document\.querySelector\(\s*(['"])#swFont\2\s*\)/g;

const SELECT_VALUE_ASSIGNMENT_PATTERN =
  /\b([A-Za-z_$][\w$]*)\.value\s*=\s*(['"])(.*?)\2/g;

function collectPatternVariableNames(
  scriptText: string,
  patterns: readonly RegExp[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of scriptText.matchAll(pattern)) {
      if (match[1]) {
        names.add(match[1]);
      }
    }
  }
  return names;
}

function extractSelectVariableNames(
  scriptText: string,
  selectId: string,
): ReadonlySet<string> {
  return selectId === THEME_SWITCHER_SELECT_IDS.palette
    ? collectPatternVariableNames(scriptText, [
        SW_PAL_GET_BY_ID_PATTERN,
        SW_PAL_QUERY_SELECTOR_PATTERN,
      ])
    : selectId === THEME_SWITCHER_SELECT_IDS.font
      ? collectPatternVariableNames(scriptText, [
          SW_FONT_GET_BY_ID_PATTERN,
          SW_FONT_QUERY_SELECTOR_PATTERN,
        ])
      : new Set<string>();
}

function extractAssignedString(
  scriptText: string,
  variableNames: ReadonlySet<string>,
): string | null {
  SELECT_VALUE_ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of scriptText.matchAll(SELECT_VALUE_ASSIGNMENT_PATTERN)) {
    const [, variableName, , value] = match;
    if (variableName && value && variableNames.has(variableName)) {
      return value;
    }
  }
  return null;
}

function selectedPaletteFromScript(
  scriptText: string,
): PresentationPalette | null {
  const selectedPalette = extractAssignedString(
    scriptText,
    extractSelectVariableNames(scriptText, THEME_SWITCHER_SELECT_IDS.palette),
  );
  const paletteMatch = /^([MV]):(.+)$/.exec(selectedPalette ?? "");
  if (!paletteMatch?.[1] || !paletteMatch[2]) {
    return null;
  }
  const paletteMap =
    paletteMatch[1] === "M"
      ? extractPaletteMap(scriptText, THEME_SCRIPT_VARIABLES.monoPaletteMap)
      : extractPaletteMap(scriptText, THEME_SCRIPT_VARIABLES.vibrantPaletteMap);
  return paletteMap[paletteMatch[2]] ?? null;
}

function selectedFontPairFromScript(
  scriptText: string,
): PresentationFontPair | null {
  const selectedFont = extractAssignedString(
    scriptText,
    extractSelectVariableNames(scriptText, THEME_SWITCHER_SELECT_IDS.font),
  );
  if (!selectedFont) {
    return null;
  }
  const fontMap = extractFontMap(scriptText, THEME_SCRIPT_VARIABLES.fontMap);
  return fontMap[selectedFont] ?? null;
}

function hexLuminance(hexColor: string): number {
  const normalized = hexColor.replace("#", "");
  const channels = [0, 2, 4].map((index) => {
    const value = Number.parseInt(normalized.slice(index, index + 2), 16) / 255;
    return value <= 0.039_28
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}

function contrastRatio(colorA: string, colorB: string): number {
  const luminanceA = hexLuminance(colorA);
  const luminanceB = hexLuminance(colorB);
  return (
    (Math.max(luminanceA, luminanceB) + 0.05) /
    (Math.min(luminanceA, luminanceB) + 0.05)
  );
}

function hexToRgb(hexColor: string): readonly [number, number, number] {
  const normalized = hexColor.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb
    .map((value) => {
      return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
    })
    .join("")}`;
}

function mixRgb(
  colorA: readonly [number, number, number],
  colorB: readonly [number, number, number],
  amount: number,
): readonly [number, number, number] {
  return [
    Math.round(colorA[0] * (1 - amount) + colorB[0] * amount),
    Math.round(colorA[1] * (1 - amount) + colorB[1] * amount),
    Math.round(colorA[2] * (1 - amount) + colorB[2] * amount),
  ];
}

function previewTextColorOn(background: string): string {
  return hexLuminance(background) > 0.45 ? "#15151A" : "#FFFFFF";
}

function safePreviewGround(accent: string): readonly [string, string] {
  const text = hexLuminance(accent) < 0.5 ? "#FFFFFF" : "#15131C";
  const target: readonly [number, number, number] =
    text === "#FFFFFF" ? [10, 9, 14] : [255, 255, 255];
  const accentRgb = hexToRgb(accent);
  for (let amount = 0; amount <= 1.0001; amount += 0.04) {
    const ground = rgbToHex(mixRgb(accentRgb, target, amount));
    if (contrastRatio(text, ground) >= 4.6) {
      return [ground, text];
    }
  }
  return [accent, text];
}

function cssFontFamilyName(name: string): string {
  return `'${name.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`)}'`;
}

function materializedThemeCss(params: {
  readonly fontPair: PresentationFontPair | null;
  readonly palette: PresentationPalette;
}): string {
  const [bg, surface, ink, soft, ph, [accent, s1, s2, s3]] = params.palette;
  const accents = [accent, s1, s2, s3] as const;
  const accentVariables = accents
    .map((accentColor, index) => {
      const [ground, text] = safePreviewGround(accentColor);
      return `--g${index}:${ground};--t${index}:${text};`;
    })
    .join("");
  const fontVariables = params.fontPair
    ? `--fd:${cssFontFamilyName(params.fontPair[0])},'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;--fb:${cssFontFamilyName(params.fontPair[1])},'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;`
    : "";

  return `
    :root {
      --bg:${bg};
      --surface:${surface};
      --ink:${ink};
      --soft:${soft};
      --ph:${ph};
      --accent:${accent};
      --s1:${s1};
      --s2:${s2};
      --s3:${s3};
      --oa:${previewTextColorOn(accent)};
      --o1:${previewTextColorOn(s1)};
      --o2:${previewTextColorOn(s2)};
      --o3:${previewTextColorOn(s3)};
      --ka:${contrastRatio(accent, bg) >= 4.5 ? accent : ink};
      --kad:${contrastRatio(accent, ink) >= 4.5 ? accent : bg};
      --k1:${contrastRatio(s1, bg) >= 4.5 ? s1 : ink};
      --k2:${contrastRatio(s2, bg) >= 4.5 ? s2 : ink};
      --k3:${contrastRatio(s3, bg) >= 4.5 ? s3 : ink};
      ${accentVariables}
      ${fontVariables}
    }
  `;
}

function materializeThemeSwitcherDefaults(doc: Document): void {
  const scriptText = Array.from(doc.querySelectorAll("script"))
    .map((script) => {
      return script.textContent ?? "";
    })
    .join("\n");
  const palette = selectedPaletteFromScript(scriptText);
  if (!palette) {
    return;
  }
  const style = doc.createElement("style");
  style.dataset.vm0MaterializedTheme = "true";
  style.textContent = materializedThemeCss({
    fontPair: selectedFontPairFromScript(scriptText),
    palette,
  });
  doc.head.append(style);
}

export function patchPresentationHtml(params: {
  readonly blocks: readonly PresentationEditBlock[];
  readonly html: string;
  readonly slides: readonly PresentationSlideDraft[];
}): string {
  const doc = new DOMParser().parseFromString(params.html, "text/html");
  for (const block of params.blocks) {
    const slide = findSlide(doc, block.slideId);
    const editable = slide ? findEditable(slide, block.editId) : null;
    if (editable && editable.textContent !== block.text) {
      editable.textContent = block.text;
    }
  }

  const metadata = parseDeckMetadata(doc) as MutableDeckMetadata;
  metadata.kind = "presentation-html";
  metadata.editProtocolVersion = metadata.editProtocolVersion ?? 1;
  metadata.slides = metadata.slides ?? {};
  for (const slide of params.slides) {
    metadata.slides[slide.id] = {
      ...metadata.slides[slide.id],
      speakerNotes: slide.notes,
    };
  }
  ensureMetadataScript(doc).textContent = JSON.stringify(metadata, null, 2);
  return serializeDoc(doc);
}

export function applyPresentationSpeakerNotesPatch(params: {
  readonly patch: PresentationSpeakerNotesPatch;
  readonly slides: readonly PresentationSlideDraft[];
}): {
  readonly appliedCount: number;
  readonly slides: readonly PresentationSlideDraft[];
} {
  const notesBySlideId = new Map<string, string>();
  for (const item of params.patch.slides) {
    const notes = item.speakerNotes.trim();
    if (notes) {
      notesBySlideId.set(item.slideId, notes);
    }
  }

  let appliedCount = 0;
  const slides = params.slides.map((slide) => {
    if (slide.notes.trim()) {
      return slide;
    }
    const notes = notesBySlideId.get(slide.id);
    if (!notes) {
      return slide;
    }
    appliedCount += 1;
    return { ...slide, notes };
  });

  return { appliedCount, slides };
}

export function previewPresentationHtml(params: {
  readonly activeSlideId: string;
  readonly html: string;
}): string {
  const doc = new DOMParser().parseFromString(params.html, "text/html");
  materializeThemeSwitcherDefaults(doc);
  sanitizePreviewTree(doc);
  const previewDoc = document.implementation.createHTMLDocument(
    doc.title || "Presentation preview",
  );
  for (const node of Array.from(doc.head.childNodes)) {
    previewDoc.head.append(node.cloneNode(true));
  }
  const stage = previewDoc.createElement("div");
  stage.dataset.vm0EditorStage = "true";
  previewDoc.body.append(stage);
  for (const [index, slide] of selectSlideElements(doc).entries()) {
    if (slideIdForElement(slide, index) === params.activeSlideId) {
      const slideId = slideIdForElement(slide, index);
      for (const [editableIndex, editable] of selectEditableElements(
        slide,
      ).entries()) {
        if (editable instanceof HTMLElement) {
          editable.dataset.vm0EditorSlideId = slideId;
          editable.dataset.vm0EditorEditId =
            editIdForElement(editable, editableIndex) ?? "";
        }
      }
      const slideClone = slide.cloneNode(true);
      if (slideClone instanceof Element) {
        sanitizePreviewTree(slideClone);
      }
      stage.append(slideClone);
      break;
    }
  }
  const style = previewDoc.createElement("style");
  style.textContent = `
    html, body {
      width: 100%;
      height: 100%;
      margin: 0 !important;
      overflow: hidden !important;
      background: #fff !important;
    }
    body {
      display: block !important;
    }
    [data-vm0-editor-stage] {
      width: 100%;
      height: 100%;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      overflow: hidden !important;
    }
    [data-vm0-editor-stage] > * {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      max-width: 100% !important;
      max-height: 100% !important;
      margin: 0 !important;
      box-sizing: border-box !important;
    }
    [data-vm0-editor-stage] > .slide,
    [data-vm0-editor-stage] > .ppt-slide,
    [data-vm0-editor-stage] > .presentation-slide,
    [data-vm0-editor-stage] > .deck-slide,
    [data-vm0-editor-stage] > .slide-page,
    [data-vm0-editor-stage] > section,
    [data-vm0-editor-stage] > [data-vm0-slide],
    [data-vm0-editor-stage] > [data-slide],
    [data-vm0-editor-stage] > [data-slide-index],
    [data-vm0-editor-stage] > [data-page] {
      width: 100% !important;
      height: 100% !important;
      min-width: 0 !important;
      min-height: 0 !important;
      margin: 0 !important;
      border: 0 !important;
      outline: 0 !important;
      box-shadow: none !important;
      border-radius: 0 !important;
      overflow: hidden !important;
      box-sizing: border-box !important;
    }
    [data-vm0-editor-stage] > .slide > .stage,
    [data-vm0-editor-stage] > .ppt-slide > .stage,
    [data-vm0-editor-stage] > .presentation-slide > .stage,
    [data-vm0-editor-stage] > .deck-slide > .stage,
    [data-vm0-editor-stage] > .slide-page > .stage,
    [data-vm0-editor-stage] > section > .stage,
    [data-vm0-editor-stage] > [data-vm0-slide] > .stage,
    [data-vm0-editor-stage] > [data-slide] > .stage,
    [data-vm0-editor-stage] > [data-slide-index] > .stage,
    [data-vm0-editor-stage] > [data-page] > .stage {
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      border: 0 !important;
      outline: 0 !important;
      box-shadow: none !important;
      border-radius: 0 !important;
      box-sizing: border-box !important;
    }
    [data-vm0-editor-edit-id] {
      cursor: text !important;
      outline: 2px solid transparent !important;
      outline-offset: 4px !important;
      z-index: 2 !important;
      pointer-events: auto !important;
      user-select: text !important;
      -webkit-user-select: text !important;
      -webkit-user-modify: read-write-plaintext-only !important;
      caret-color: auto !important;
    }
    [data-vm0-editor-edit-id]:hover,
    [data-vm0-editor-edit-id]:focus {
      outline-color: #0f82ff !important;
    }
  `;
  previewDoc.head.append(style);
  sanitizePreviewDocument(previewDoc);
  return serializeDoc(previewDoc);
}
