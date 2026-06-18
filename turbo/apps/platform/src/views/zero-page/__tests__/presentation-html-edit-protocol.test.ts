import { describe, expect, it } from "vitest";
import { previewPresentationHtml } from "../presentation-html-edit-protocol.ts";

describe("previewPresentationHtml", () => {
  it("normalizes nested slide stages to fill the preview frame", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-1",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>
              .slide { width: 100vw; height: 100vh; background: #111; }
              .stage { width: min(100vw, 177.7778vh); height: min(56.25vw, 100vh); margin: auto; }
            </style>
          </head>
          <body>
            <div class="slide" data-vm0-slide data-slide-id="slide-1">
              <div class="stage">
                <h1>Slide</h1>
              </div>
            </div>
          </body>
        </html>
      `,
    });
    const doc = new DOMParser().parseFromString(previewHtml, "text/html");
    const injectedCss = Array.from(doc.querySelectorAll("style"))
      .map((style) => {
        return style.textContent ?? "";
      })
      .join("\n");

    expect(injectedCss).toContain("[data-vm0-editor-stage] > .slide");
    expect(injectedCss).toContain("[data-vm0-editor-stage] > .slide > .stage");
    expect(injectedCss).toContain("box-shadow: none !important");
    expect(injectedCss).toContain("border-radius: 0 !important");
  });
});
