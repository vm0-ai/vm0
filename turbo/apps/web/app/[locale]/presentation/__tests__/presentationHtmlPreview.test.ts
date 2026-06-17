import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  parsePresentationPreviewDeck,
  pointerIndexForClientX,
  previewPresentationSlideHtml,
} from "../presentationHtmlPreview";

describe("presentation HTML preview", () => {
  let window: Window;

  beforeAll(() => {
    window = new Window({ url: "https://www.vm0.ai" });
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("DOMParser", window.DOMParser);
    vi.stubGlobal("Element", window.Element);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
  });

  afterAll(async () => {
    await window.happyDOM.abort();
    vi.unstubAllGlobals();
  });

  it("parses stable slide ids and titles from presentation HTML", () => {
    const deck = parsePresentationPreviewDeck(`
      <!doctype html>
      <html>
        <body>
          <div class="slide" data-slide-id="intro"><h1>Intro</h1></div>
          <div class="slide" data-slide-id="plan"><h2>Plan</h2></div>
        </body>
      </html>
    `);

    expect(deck.slides).toEqual([
      { id: "intro", title: "Intro" },
      { id: "plan", title: "Plan" },
    ]);
  });

  it("renders only the active slide into a sandbox preview document", () => {
    const preview = previewPresentationSlideHtml({
      activeSlideId: "plan",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>.slide { color: red; }</style>
          </head>
          <body>
            <div class="slide" data-slide-id="intro" onclick="blocked()">
              <h1>Intro</h1>
            </div>
            <div class="slide" data-slide-id="plan">
              <h2>Plan</h2>
              <iframe src="https://example.com"></iframe>
            </div>
          </body>
        </html>
      `,
      sourceUrl: "https://deck.sites.vm0.io",
    });

    expect(preview).toContain('<base href="https://deck.sites.vm0.io">');
    expect(preview).toContain("Plan");
    expect(preview).not.toContain("Intro");
    expect(preview).not.toContain("<iframe");
    expect(preview).not.toContain("onclick");
    expect(preview).toContain("script-src 'none'");
  });

  it("maps horizontal pointer position to a bounded slide index", () => {
    const rect = { left: 100, width: 500 };

    expect(pointerIndexForClientX({ clientX: 50, count: 5, rect })).toBe(0);
    expect(pointerIndexForClientX({ clientX: 100, count: 5, rect })).toBe(0);
    expect(pointerIndexForClientX({ clientX: 349, count: 5, rect })).toBe(2);
    expect(pointerIndexForClientX({ clientX: 600, count: 5, rect })).toBe(4);
    expect(pointerIndexForClientX({ clientX: 700, count: 5, rect })).toBe(4);
  });
});
