const PRESENTATION_ELEMENT_ID_ATTRIBUTE = "data-vm0-element-id";
const PRESENTATION_ELEMENT_OFFSET_X_ATTRIBUTE = "data-vm0-offset-x";
const PRESENTATION_ELEMENT_OFFSET_Y_ATTRIBUTE = "data-vm0-offset-y";
const GENERATED_PRESENTATION_ELEMENT_ID_PREFIX = "vm0-generated:";
export const PRESENTATION_ELEMENT_OFFSET_RUNTIME_APPLIED_ATTRIBUTE =
  "data-vm0-offset-runtime-applied";
export const PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID =
  "vm0-presentation-element-offset-runtime";
export const PRESENTATION_ELEMENT_OFFSET_APPLY_FUNCTION_NAME =
  "__vm0ApplyPresentationElementOffsets";
export const PRESENTATION_ELEMENT_OFFSET_PREVIEW_NONCE =
  "vm0-presentation-element-offset-runtime";

const OFFSET_PRECISION = 6;
const MAX_OFFSET_MAGNITUDE = 1_000_000;
const OFFSET_ZERO_THRESHOLD = 0.5 / 10 ** OFFSET_PRECISION;
const SERIALIZED_OFFSET_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const SLIDE_SELECTOR = [
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
].join(",");

interface PresentationElementOffset {
  readonly x: number;
  readonly y: number;
}

export interface PresentationMoveBlock {
  readonly elementId: string | null;
  readonly elementIdGenerated: boolean;
  readonly moveId: string;
  readonly objectIndex: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly slideId: string;
}

export function createGeneratedPresentationElementId(): string {
  return `${GENERATED_PRESENTATION_ELEMENT_ID_PREFIX}${globalThis.crypto.randomUUID()}`;
}

function isGeneratedPresentationElementId(elementId: string | null): boolean {
  return (
    elementId?.startsWith(GENERATED_PRESENTATION_ELEMENT_ID_PREFIX) === true
  );
}

type PresentationMovementUnsupportedReason =
  "restrictive-content-security-policy";

interface PresentationMovementSupport {
  readonly reason: PresentationMovementUnsupportedReason | null;
  readonly supported: boolean;
}

export function normalizePresentationElementOffset(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_OFFSET_MAGNITUDE) {
    return 0;
  }
  const normalized = Number(value.toFixed(OFFSET_PRECISION));
  return Math.abs(normalized) < OFFSET_ZERO_THRESHOLD ? 0 : normalized;
}

function serializePresentationElementOffset(value: number): string {
  const normalized = normalizePresentationElementOffset(value);
  if (normalized === 0) {
    return "0";
  }
  return normalized
    .toFixed(OFFSET_PRECISION)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
}

function parseSerializedOffset(value: string | null): number | null {
  if (value === null || !SERIALIZED_OFFSET_PATTERN.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_OFFSET_MAGNITUDE
    ? normalizePresentationElementOffset(parsed)
    : null;
}

function readPresentationElementOffset(
  element: Element,
): PresentationElementOffset | null {
  const x = parseSerializedOffset(
    element.getAttribute(PRESENTATION_ELEMENT_OFFSET_X_ATTRIBUTE),
  );
  const y = parseSerializedOffset(
    element.getAttribute(PRESENTATION_ELEMENT_OFFSET_Y_ATTRIBUTE),
  );
  if (x === null || y === null || (x === 0 && y === 0)) {
    return null;
  }
  return { x, y };
}

export function hasPresentationElementOffsets(doc: Document): boolean {
  return Array.from(
    doc.querySelectorAll(
      `[${PRESENTATION_ELEMENT_OFFSET_X_ATTRIBUTE}][${PRESENTATION_ELEMENT_OFFSET_Y_ATTRIBUTE}]`,
    ),
  ).some((element) => {
    return readPresentationElementOffset(element) !== null;
  });
}

function hasAuthoredIndividualTranslate(element: HTMLElement): boolean {
  const translate = element.style.getPropertyValue("translate").trim();
  return translate !== "" && translate !== "none";
}

function isExcludedCandidateTagName(tagName: string): boolean {
  switch (tagName) {
    case "CAPTION":
    case "COL":
    case "COLGROUP":
    case "EMBED":
    case "IFRAME":
    case "LINK":
    case "META":
    case "NOSCRIPT":
    case "OBJECT":
    case "SCRIPT":
    case "STYLE":
    case "TBODY":
    case "TD":
    case "TFOOT":
    case "TH":
    case "THEAD":
    case "TEMPLATE":
    case "TR": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function isStructuralMoveCandidate(element: Element): element is HTMLElement {
  if (
    !(element instanceof HTMLElement) ||
    isExcludedCandidateTagName(element.tagName) ||
    element.hidden ||
    element.getAttribute("aria-hidden") === "true" ||
    element.dataset.vm0Static !== undefined ||
    element.dataset.vm0EditorOwned !== undefined ||
    hasAuthoredIndividualTranslate(element)
  ) {
    return false;
  }
  return true;
}

function selectPresentationLayoutRoot(slide: Element): HTMLElement | null {
  const stage = Array.from(slide.children).find((child) => {
    return child instanceof HTMLElement && child.classList.contains("stage");
  });
  if (stage instanceof HTMLElement) {
    return stage;
  }
  return slide instanceof HTMLElement ? slide : null;
}

export function selectPresentationMoveCandidates(
  slide: Element,
): readonly HTMLElement[] {
  const root = selectPresentationLayoutRoot(slide);
  if (!root) {
    return [];
  }
  return Array.from(root.children).filter(isStructuralMoveCandidate);
}

export function resolvePresentationMoveCandidate(params: {
  readonly slide: Element;
  readonly target: Element;
}): HTMLElement | null {
  const root = selectPresentationLayoutRoot(params.slide);
  if (!root || !root.contains(params.target)) {
    return null;
  }
  let candidate: Element | null = params.target;
  while (candidate?.parentElement && candidate.parentElement !== root) {
    candidate = candidate.parentElement;
  }
  if (
    candidate?.parentElement !== root ||
    !isStructuralMoveCandidate(candidate)
  ) {
    return null;
  }
  return candidate;
}

function presentationMoveId(params: {
  readonly objectIndex: number;
  readonly slideId: string;
}): string {
  return `${params.slideId}:object-${params.objectIndex + 1}`;
}

export function presentationMoveBlocksForSlide(params: {
  readonly slide: Element;
  readonly slideId: string;
}): readonly PresentationMoveBlock[] {
  return selectPresentationMoveCandidates(params.slide).map(
    (element, objectIndex): PresentationMoveBlock => {
      const offset = readPresentationElementOffset(element);
      const rawElementId = element.getAttribute(
        PRESENTATION_ELEMENT_ID_ATTRIBUTE,
      );
      const elementId = rawElementId?.trim() ? rawElementId : null;
      return {
        elementId,
        elementIdGenerated: isGeneratedPresentationElementId(elementId),
        moveId: presentationMoveId({
          objectIndex,
          slideId: params.slideId,
        }),
        objectIndex,
        offsetX: offset?.x ?? 0,
        offsetY: offset?.y ?? 0,
        slideId: params.slideId,
      };
    },
  );
}

export function findPresentationMoveCandidate(params: {
  readonly block: PresentationMoveBlock;
  readonly slide: Element;
}): HTMLElement | null {
  const candidates = selectPresentationMoveCandidates(params.slide);
  if (params.block.elementId) {
    const byElementId = candidates.find((candidate) => {
      return (
        candidate.getAttribute(PRESENTATION_ELEMENT_ID_ATTRIBUTE) ===
        params.block.elementId
      );
    });
    if (byElementId) {
      return byElementId;
    }
  }
  return candidates[params.block.objectIndex] ?? null;
}

export function writePresentationElementOffset(params: {
  readonly element: HTMLElement;
  readonly elementId: string | null;
  readonly elementIdGenerated: boolean;
  readonly offsetX: number;
  readonly offsetY: number;
}): void {
  const offsetX = normalizePresentationElementOffset(params.offsetX);
  const offsetY = normalizePresentationElementOffset(params.offsetY);
  if (offsetX === 0 && offsetY === 0) {
    params.element.removeAttribute(PRESENTATION_ELEMENT_OFFSET_X_ATTRIBUTE);
    params.element.removeAttribute(PRESENTATION_ELEMENT_OFFSET_Y_ATTRIBUTE);
    if (params.elementIdGenerated) {
      params.element.removeAttribute(PRESENTATION_ELEMENT_ID_ATTRIBUTE);
    }
    return;
  }
  if (!params.elementId?.trim()) {
    return;
  }
  params.element.setAttribute(
    PRESENTATION_ELEMENT_ID_ATTRIBUTE,
    params.elementId,
  );
  params.element.setAttribute(
    PRESENTATION_ELEMENT_OFFSET_X_ATTRIBUTE,
    serializePresentationElementOffset(offsetX),
  );
  params.element.setAttribute(
    PRESENTATION_ELEMENT_OFFSET_Y_ATTRIBUTE,
    serializePresentationElementOffset(offsetY),
  );
}

function cspDirectiveContent(
  content: string,
  directiveName: string,
): readonly string[] | null {
  for (const directive of content.split(";")) {
    const tokens = directive.trim().split(/\s+/);
    if (tokens[0]?.toLowerCase() === directiveName) {
      return tokens.slice(1).map((token) => {
        return token.toLowerCase();
      });
    }
  }
  return null;
}

function cspAllowsInlineScript(content: string): boolean {
  const scriptSource =
    cspDirectiveContent(content, "script-src-elem") ??
    cspDirectiveContent(content, "script-src") ??
    cspDirectiveContent(content, "default-src");
  if (scriptSource === null) {
    return true;
  }
  const hasNonceOrHash = scriptSource.some((source) => {
    return (
      source.startsWith("'nonce-") ||
      source.startsWith("'sha256-") ||
      source.startsWith("'sha384-") ||
      source.startsWith("'sha512-")
    );
  });
  return scriptSource.includes("'unsafe-inline'") && !hasNonceOrHash;
}

export function presentationMovementSupport(
  doc: Document,
): PresentationMovementSupport {
  const restrictiveCsp = Array.from(
    doc.querySelectorAll("meta[http-equiv]"),
  ).some((meta) => {
    return (
      meta.getAttribute("http-equiv")?.toLowerCase() ===
        "content-security-policy" &&
      !cspAllowsInlineScript(meta.getAttribute("content") ?? "")
    );
  });
  return restrictiveCsp
    ? {
        reason: "restrictive-content-security-policy",
        supported: false,
      }
    : { reason: null, supported: true };
}

export function presentationElementOffsetRuntimeSource(params: {
  readonly autoStart: boolean;
}): string {
  const autoStartSource = params.autoStart
    ? `const start=()=>{apply();schedule()};if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start,{once:true})}else{start()}window.addEventListener("resize",schedule);if(typeof ResizeObserver!=="undefined"){observer=new ResizeObserver(schedule);observeTargets()}`
    : "";
  return `(()=>{const xAttr=${JSON.stringify(PRESENTATION_ELEMENT_OFFSET_X_ATTRIBUTE)},yAttr=${JSON.stringify(PRESENTATION_ELEMENT_OFFSET_Y_ATTRIBUTE)},appliedAttr=${JSON.stringify(PRESENTATION_ELEMENT_OFFSET_RUNTIME_APPLIED_ATTRIBUTE)},slideSelector=${JSON.stringify(SLIDE_SELECTOR)},numberPattern=/^-?(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$/,maxOffset=${String(MAX_OFFSET_MAGNITUDE)},owned=new WeakSet();let frame=0,observer=null;const read=(value)=>{if(value===null||!numberPattern.test(value.trim()))return null;const parsed=Number(value);return Number.isFinite(parsed)&&Math.abs(parsed)<=maxOffset?parsed:null};const clamp=(value,min,max)=>min<=max?Math.min(Math.max(value,min),max):0;const apply=()=>{for(const element of document.querySelectorAll("["+xAttr+"]["+yAttr+"]")){if(!(element instanceof HTMLElement))continue;const x=read(element.getAttribute(xAttr)),y=read(element.getAttribute(yAttr));if(x===null||y===null||(x===0&&y===0))continue;const parent=element.parentElement;if(!parent)continue;if(!owned.has(element)){const authored=getComputedStyle(element).translate;if(authored&&authored!=="none"&&authored!=="0px"&&authored!=="0px 0px")continue;owned.add(element)}element.style.removeProperty("translate");const parentRect=parent.getBoundingClientRect(),baseRect=element.getBoundingClientRect(),slide=parent.closest(slideSelector),slideRect=(slide??parent).getBoundingClientRect();if(parentRect.width<=0||parentRect.height<=0||baseRect.width<=0||baseRect.height<=0)continue;const translatedX=clamp(x*parentRect.width,slideRect.left-baseRect.left,slideRect.right-baseRect.right),translatedY=clamp(y*parentRect.height,slideRect.top-baseRect.top,slideRect.bottom-baseRect.bottom);element.style.translate=translatedX+"px "+translatedY+"px";element.setAttribute(appliedAttr,"true")}};const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(apply)};const observeTargets=()=>{if(!observer)return;const targets=new Set();for(const element of document.querySelectorAll("["+xAttr+"]["+yAttr+"]")){targets.add(element);if(element.parentElement)targets.add(element.parentElement)}for(const target of targets)observer.observe(target)};window[${JSON.stringify(PRESENTATION_ELEMENT_OFFSET_APPLY_FUNCTION_NAME)}]=apply;${autoStartSource}})();`;
}

export function syncPresentationElementOffsetRuntime(doc: Document): void {
  for (const script of Array.from(
    doc.querySelectorAll(
      `script#${PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID}`,
    ),
  )) {
    script.remove();
  }
  if (!hasPresentationElementOffsets(doc)) {
    return;
  }
  const runtime = doc.createElement("script");
  runtime.id = PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID;
  runtime.textContent = presentationElementOffsetRuntimeSource({
    autoStart: true,
  });
  doc.body.append(runtime);
}

export function appendPresentationElementOffsetPreviewRuntime(
  doc: Document,
): void {
  for (const script of Array.from(
    doc.querySelectorAll(
      `script#${PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID}`,
    ),
  )) {
    script.remove();
  }
  if (!hasPresentationElementOffsets(doc)) {
    return;
  }
  const runtime = doc.createElement("script");
  runtime.id = PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID;
  runtime.setAttribute("nonce", PRESENTATION_ELEMENT_OFFSET_PREVIEW_NONCE);
  runtime.textContent = presentationElementOffsetRuntimeSource({
    autoStart: true,
  });
  doc.body.append(runtime);
}
