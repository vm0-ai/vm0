const BLUR_ATTRIBUTE = "data-okou-recorder-blurred";
const BLUR_FILTER = "blur(10px)";

interface OriginalElementStyle {
  readonly attributeValue: string | null;
  readonly filterPriority: string;
  readonly filterValue: string;
}

interface BlurRecord {
  readonly appliedElements: Map<HTMLElement, OriginalElementStyle>;
  readonly selector: string;
}

function cssIdentifier(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, (character) => {
    return `\\${character.codePointAt(0)?.toString(16) ?? "20"} `;
  });
}

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function uniqueSelector(element: HTMLElement): string | null {
  if (element.id) {
    const selector = `#${cssIdentifier(element.id)}`;
    if (document.querySelectorAll(selector).length === 1) {
      return selector;
    }
  }
  for (const attribute of [
    "data-testid",
    "data-test",
    "data-qa",
    "aria-label",
    "name",
  ]) {
    const value = element.getAttribute(attribute);
    if (!value) {
      continue;
    }
    const selector = `${element.localName}[${attribute}="${cssString(value)}"]`;
    if (document.querySelectorAll(selector).length === 1) {
      return selector;
    }
  }
  return null;
}

export function selectorForElement(element: HTMLElement): string {
  const stable = uniqueSelector(element);
  if (stable) {
    return stable;
  }
  const segments: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) {
      break;
    }
    const localName = current.localName;
    const siblings = [...parent.children].filter((candidate) => {
      return candidate.localName === localName;
    });
    const index = siblings.indexOf(current) + 1;
    segments.unshift(`${localName}:nth-of-type(${Math.max(1, index)})`);
    const parentStable = uniqueSelector(parent);
    if (parentStable) {
      segments.unshift(parentStable);
      return segments.join(" > ");
    }
    current = parent;
  }
  return segments.length > 0
    ? `body > ${segments.join(" > ")}`
    : element.localName;
}

function restoreElement(
  element: HTMLElement,
  original: OriginalElementStyle,
): void {
  if (original.filterValue) {
    element.style.setProperty(
      "filter",
      original.filterValue,
      original.filterPriority,
    );
  } else {
    element.style.removeProperty("filter");
  }
  if (original.attributeValue === null) {
    element.removeAttribute(BLUR_ATTRIBUTE);
  } else {
    element.setAttribute(BLUR_ATTRIBUTE, original.attributeValue);
  }
}

/**
 * Keeps every selected element blurred for the whole recording.
 *
 * The blur is an inline `filter` on the element itself, so it travels with the
 * element while the page scrolls. Virtualized lists, infinite scroll, and SPA
 * re-renders destroy and rebuild those nodes, so the manager also stores a
 * selector per selection and re-applies the blur to every current match after
 * DOM mutations, style overwrites, and scroll.
 */
export class BlurManager {
  readonly #onChange: (count: number) => void;
  readonly #records: BlurRecord[] = [];
  readonly #observer: MutationObserver;
  readonly #onScroll: () => void;
  #reapplyFrame: number | null = null;

  constructor(onChange: (count: number) => void) {
    this.#onChange = onChange;
    this.#observer = new MutationObserver(() => {
      this.#scheduleReapply();
    });
    this.#observer.observe(document.documentElement, {
      attributeFilter: ["class", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    this.#onScroll = () => {
      this.#scheduleReapply();
    };
    window.addEventListener("scroll", this.#onScroll, {
      capture: true,
      passive: true,
    });
  }

  get count(): number {
    return this.#records.length;
  }

  has(element: HTMLElement): boolean {
    return this.#records.some((record) => {
      return record.appliedElements.has(element);
    });
  }

  add(element: HTMLElement): boolean {
    if (
      element === document.body ||
      element === document.documentElement ||
      this.has(element)
    ) {
      return false;
    }
    const record: BlurRecord = {
      appliedElements: new Map(),
      selector: selectorForElement(element),
    };
    this.#apply(record, element);
    this.#records.push(record);
    this.#onChange(this.count);
    return true;
  }

  undo(): void {
    const record = this.#records.pop();
    if (!record) {
      return;
    }
    this.#restore(record);
    this.#onChange(this.count);
  }

  clear(): void {
    for (const record of this.#records) {
      this.#restore(record);
    }
    this.#records.length = 0;
    this.#onChange(0);
  }

  destroy(): void {
    this.#observer.disconnect();
    window.removeEventListener("scroll", this.#onScroll, { capture: true });
    if (this.#reapplyFrame !== null) {
      cancelAnimationFrame(this.#reapplyFrame);
      this.#reapplyFrame = null;
    }
    this.clear();
  }

  #apply(record: BlurRecord, element: HTMLElement): void {
    if (!record.appliedElements.has(element)) {
      record.appliedElements.set(element, {
        attributeValue: element.getAttribute(BLUR_ATTRIBUTE),
        filterPriority: element.style.getPropertyPriority("filter"),
        filterValue: element.style.getPropertyValue("filter"),
      });
    }
    if (element.getAttribute(BLUR_ATTRIBUTE) !== "") {
      element.setAttribute(BLUR_ATTRIBUTE, "");
    }
    // Writing an unchanged value would retrigger the attribute observer and
    // spin the reapply loop forever.
    if (element.style.getPropertyValue("filter") !== BLUR_FILTER) {
      element.style.setProperty("filter", BLUR_FILTER, "important");
    }
  }

  #restore(record: BlurRecord): void {
    for (const [element, original] of record.appliedElements) {
      restoreElement(element, original);
    }
    record.appliedElements.clear();
  }

  #scheduleReapply(): void {
    if (this.#reapplyFrame !== null) {
      return;
    }
    this.#reapplyFrame = requestAnimationFrame(() => {
      this.#reapplyFrame = null;
      for (const record of this.#records) {
        for (const [element] of record.appliedElements) {
          if (element.isConnected) {
            this.#apply(record, element);
          } else {
            record.appliedElements.delete(element);
          }
        }
        for (const match of document.querySelectorAll<HTMLElement>(
          record.selector,
        )) {
          this.#apply(record, match);
        }
      }
    });
  }
}
