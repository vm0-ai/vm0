import { describe, expect, it } from "vitest";
import {
  parsePresentationEditDraft,
  patchPresentationHtml,
  previewPresentationHtml,
} from "../presentation-html-edit-protocol.ts";
import {
  createGeneratedPresentationElementId,
  PRESENTATION_ELEMENT_OFFSET_PREVIEW_NONCE,
  PRESENTATION_ELEMENT_OFFSET_RUNTIME_APPLIED_ATTRIBUTE,
  PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID,
  resolvePresentationMoveCandidate,
} from "../presentation-html-element-offsets.ts";

describe("previewPresentationHtml", () => {
  it("materializes theme switcher defaults before removing scripts", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-1",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>
              :root {
                --bg:#FFFFFF;
                --accent:#7257E6;
                --s1:#FF6B4A;
                --s2:#AEE63E;
                --s3:#3FA9F5;
              }
            </style>
          </head>
          <body>
            <div class="slide" data-slide-id="slide-1">
              <div class="stage">
                <h1 style="color:var(--accent)">Slide</h1>
              </div>
            </div>
            <script>
              var MONO={
                "Mauve Dusk":["#FAF7FB","#FFFFFF","#2B2533","#635B70","#ECE7F0",["#9C7BB8","#8AA0C9","#E0B6C9","#2B2533"]]
              };
              var VIB={
                "Prism":["#FFFFFF","#F7F7FA","#1A1726","#5C5870","#ECECF2",["#7257E6","#FF6B4A","#AEE63E","#3FA9F5"]]
              };
              var FONTS={
                "Fredoka / Quicksand":["Fredoka","Quicksand"]
              };
              var paletteSelect=document.getElementById('swPal'),fontSelect=document.getElementById('swFont');
              paletteSelect.value='M:Mauve Dusk';fontSelect.value='Fredoka / Quicksand';
              paletteSelect.onchange();fontSelect.onchange();
            </script>
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

    expect(doc.querySelector("script")).toBeNull();
    expect(injectedCss).toContain("--bg:#FAF7FB");
    expect(injectedCss).toContain("--accent:#9C7BB8");
    expect(injectedCss).toContain("--s1:#8AA0C9");
    expect(injectedCss).toContain("--s2:#E0B6C9");
    expect(injectedCss).toContain("--s3:#2B2533");
    expect(injectedCss).toContain("--g0:#85699d");
    expect(injectedCss).toContain("--fd:'Fredoka'");
    expect(injectedCss).toContain("--fb:'Quicksand'");
  });

  it("materializes theme applied via setPalette/setFont calls", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-1",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>
              :root {
                --bg:#FFFFFF;
                --accent:#7257E6;
                --s1:#FF6B4A;
                --s2:#AEE63E;
                --s3:#3FA9F5;
              }
            </style>
          </head>
          <body>
            <div class="slide" data-slide-id="slide-1">
              <div class="stage">
                <h1 style="color:var(--accent)">Slide</h1>
              </div>
            </div>
            <script>
              var MONO={
                "Warm Sand":["#FFFDF8","#FFFFFF","#262626","#5A5A5A","#ECECEC",["#F19B3A","#8DACE5","#DDB8D9","#516049"]]
              };
              var VIB={
                "Prism":["#FFFFFF","#F7F7FA","#1A1726","#5C5870","#ECECF2",["#7257E6","#FF6B4A","#AEE63E","#3FA9F5"]]
              };
              var FONTS={
                "Archivo / Manrope":["Archivo","Manrope"]
              };
              function setPalette(v){}
              function setFont(n){}
              var sp={value:'V:Prism'},sf={value:'Poppins / Figtree'};
              sp.value='M:Warm Sand';sf.value='Archivo / Manrope';
              setPalette(sp.value);setFont(sf.value);
            </script>
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

    expect(doc.querySelector("script")).toBeNull();
    expect(injectedCss).toContain("--bg:#FFFDF8");
    expect(injectedCss).toContain("--accent:#F19B3A");
    expect(injectedCss).toContain("--s1:#8DACE5");
    expect(injectedCss).toContain("--s2:#DDB8D9");
    expect(injectedCss).toContain("--s3:#516049");
    expect(injectedCss).toContain("--fd:'Archivo'");
    expect(injectedCss).toContain("--fb:'Manrope'");
  });

  it("ignores generated object-backed switcher defaults that cannot run", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-1",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>
              :root {
                --bg:#FFFFFF;
                --accent:#7257E6;
                --s1:#FF6B4A;
                --s2:#AEE63E;
                --s3:#3FA9F5;
              }
            </style>
          </head>
          <body>
            <div class="slide" data-slide-id="slide-1">
              <div class="stage">
                <h1 style="color:var(--accent)">Slide</h1>
              </div>
            </div>
            <script>
              var MONO={
                "Bauhaus Primary":["#F7F3EA","#FFFDF8","#1C1A17","#665F55","#E6DDD0",["#D1493F","#235789","#F2B134","#1C1A17"]]
              };
              var VIB={
                "Prism":["#FFFFFF","#F7F7FA","#1A1726","#5C5870","#ECECF2",["#7257E6","#FF6B4A","#AEE63E","#3FA9F5"]]
              };
              var FONTS={
                "Poppins / Figtree":["Poppins","Figtree"]
              };
              var sp={value:''},sf={value:''};
              var gV=document.createElement('optgroup');gV.label='Vibrant - multi-colour';
              Object.keys(VIB).forEach(function(k){var o=document.createElement('option');o.value='V:'+k;o.textContent=k;gV.appendChild(o);});sp.appendChild(gV);
              var gM=document.createElement('optgroup');gM.label='Single-accent';
              Object.keys(MONO).forEach(function(k){var o=document.createElement('option');o.value='M:'+k;o.textContent=k;gM.appendChild(o);});sp.appendChild(gM);
              Object.keys(FONTS).forEach(function(k){var o=document.createElement('option');o.value=o.textContent=k;sf.appendChild(o);});
              sp.onchange=function(){};
              sf.onchange=function(){};
              sp.value='M:Bauhaus Primary';sf.value='Poppins / Figtree';sp.onchange();sf.onchange();
            </script>
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

    expect(doc.querySelector("script")).toBeNull();
    expect(
      doc.querySelector('[data-vm0-materialized-theme="true"]'),
    ).toBeNull();
    expect(injectedCss).toContain("--bg:#FFFFFF");
    expect(injectedCss).toContain("--accent:#7257E6");
  });

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

  it("preserves the authored display layout when activating a preview slide", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-2",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>
              .slide { display: none; }
              .slide.active { display: flex; }
              .slide.grid.active { display: grid; }
            </style>
          </head>
          <body>
            <section class="slide active" data-slide-id="slide-1">
              <h1>First slide</h1>
            </section>
            <section
              class="slide grid"
              data-slide-id="slide-2"
              hidden
              inert
              aria-hidden="true"
              style="display: none !important"
            >
              <h1>Second slide</h1>
            </section>
          </body>
        </html>
      `,
    });
    const doc = new DOMParser().parseFromString(previewHtml, "text/html");
    const activeSlide = doc.querySelector<HTMLElement>(
      "[data-vm0-editor-stage] > .slide",
    );
    const editorStyle = Array.from(doc.querySelectorAll("style")).at(
      -1,
    )?.textContent;
    const stageChildRule = editorStyle?.match(
      /\[data-vm0-editor-stage\] > \* \{([\s\S]*?)\}/,
    )?.[1];

    expect(activeSlide).not.toBeNull();
    expect(activeSlide?.classList.contains("active")).toBeTruthy();
    expect(activeSlide?.classList.contains("is-active")).toBeFalsy();
    expect(activeSlide?.hasAttribute("hidden")).toBeFalsy();
    expect(activeSlide?.hasAttribute("inert")).toBeFalsy();
    expect(activeSlide?.getAttribute("aria-hidden")).toBe("false");
    expect(activeSlide?.style.getPropertyValue("display")).toBe("");
    expect(stageChildRule).toBeDefined();
    expect(stageChildRule).not.toContain("display: block");
  });

  it("preserves and activates selector-matching slide ancestors", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-2",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>
              .slide { display: none; }
              .slide.active { display: flex; }
              .slide-shell { display: grid; }
            </style>
          </head>
          <body>
            <section class="slide active">
              <div class="slide-shell">
                <div data-vm0-slide data-slide-id="slide-1">
                  <h1>First slide</h1>
                </div>
              </div>
            </section>
            <section
              class="slide"
              hidden
              inert
              aria-hidden="true"
              style="display: none !important"
            >
              <div class="slide-shell">
                <div data-vm0-slide data-slide-id="slide-2">
                  <h1>Second slide</h1>
                </div>
              </div>
            </section>
          </body>
        </html>
      `,
    });
    const doc = new DOMParser().parseFromString(previewHtml, "text/html");
    const stage = doc.querySelector("[data-vm0-editor-stage]");
    const outerSlide = stage?.querySelector<HTMLElement>(":scope > .slide");
    const innerSlide = outerSlide?.querySelector<HTMLElement>(
      ".slide-shell > [data-vm0-slide]",
    );
    const title = innerSlide?.querySelector<HTMLElement>("h1");

    expect(stage?.children).toHaveLength(1);
    expect(outerSlide?.classList.contains("active")).toBeTruthy();
    expect(outerSlide?.hasAttribute("hidden")).toBeFalsy();
    expect(outerSlide?.hasAttribute("inert")).toBeFalsy();
    expect(outerSlide?.getAttribute("aria-hidden")).toBe("false");
    expect(outerSlide?.style.getPropertyValue("display")).toBe("");
    expect(innerSlide?.dataset.slideId).toBe("slide-2");
    expect(title?.dataset.vm0EditorSlideId).toBe("slide-2");
    expect(stage?.textContent).toContain("Second slide");
    expect(stage?.textContent).not.toContain("First slide");
  });

  it("uses the semantic focus ring for editable presentation content", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-1",
      html: `
        <!doctype html>
        <html>
          <body>
            <section data-vm0-slide data-slide-id="slide-1">
              <h1 data-vm0-editable="text">Slide</h1>
            </section>
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

    expect(injectedCss).toMatch(
      /\[data-vm0-editor-edit-id\]\s*{[^}]*outline:\s*4px solid transparent\s*!important;/,
    );
    expect(injectedCss).toMatch(
      /\[data-vm0-editor-edit-id\]:hover\s*{\s*outline-color:\s*#0f82ff\s*!important;/,
    );
    expect(injectedCss).toMatch(
      /\[data-vm0-editor-edit-id\]:focus\s*{\s*outline-color:\s*hsl\(var\(--ring, 15 80% 66%\)\)\s*!important;/,
    );
    expect(injectedCss).toMatch(
      /\[data-vm0-editor-edit-id\]:focus\s*{[^}]*filter:\s*none\s*!important;/,
    );
  });

  it("uses an opaque selection overlay for movable presentation content", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-1",
      movementEditingEnabled: true,
      html: `
        <!doctype html>
        <html>
          <body>
            <section data-vm0-slide data-slide-id="slide-1">
              <div style="opacity: 0.15; transform: rotate(-15deg)">Decoration</div>
            </section>
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

    expect(injectedCss).toMatch(
      /\[data-vm0-editor-selection-overlay\]\s*\{[\s\S]*?border:\s*4px solid #0f82ff\s*!important;/,
    );
    expect(injectedCss).toMatch(
      /\[data-vm0-editor-selection-overlay\]\s*\{[\s\S]*?opacity:\s*1\s*!important;/,
    );
    expect(injectedCss).toMatch(
      /\[data-vm0-editor-selection-overlay\]\s*\{[\s\S]*?pointer-events:\s*none\s*!important;/,
    );
    expect(injectedCss).toMatch(
      /\[data-vm0-editor-edit-id\]\[contenteditable="true"\]:focus\s*\{\s*outline:\s*none\s*!important;/,
    );
    expect(injectedCss).not.toContain('[data-vm0-editor-selected="true"]');
  });

  it("appends additional head styles to the preview document", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-1",
      additionalHeadStyle: ":root { --accent: #ff6600; }",
      html: `
        <!doctype html>
        <html>
          <body>
            <section data-vm0-slide data-slide-id="slide-1">
              <h1>Slide</h1>
            </section>
          </body>
        </html>
      `,
    });

    expect(previewHtml).toContain(":root { --accent: #ff6600; }");
    expect(previewHtml).not.toContain("data-vm0-editor-move-id");
  });

  it("replaces source scripts with one nonce-authorized canonical offset runtime", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-1",
      movementEditingEnabled: true,
      html: `
        <!doctype html>
        <html>
          <head>
            <meta http-equiv="Content-Security-Policy" content="script-src 'self'">
          </head>
          <body>
            <section data-vm0-slide data-slide-id="slide-1">
              <div class="stage">
                <div
                  data-vm0-element-id="element-1"
                  data-vm0-offset-x="0.025"
                  data-vm0-offset-y="-0.018519"
                  data-vm0-offset-runtime-applied="true"
                  onclick="window.sourceScriptRan = true"
                >Card</div>
              </div>
              <script id="${PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID}">
                window.sourceScriptRan = true;
              </script>
              <script>window.anotherSourceScriptRan = true;</script>
            </section>
          </body>
        </html>
      `,
    });
    const doc = new DOMParser().parseFromString(previewHtml, "text/html");
    const scripts = Array.from(doc.querySelectorAll("script"));
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');

    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.id).toBe(PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID);
    expect(scripts[0]?.getAttribute("nonce")).toBe(
      PRESENTATION_ELEMENT_OFFSET_PREVIEW_NONCE,
    );
    expect(scripts[0]?.textContent).not.toContain("sourceScriptRan");
    expect(csp?.getAttribute("content")).toContain(
      `script-src 'nonce-${PRESENTATION_ELEMENT_OFFSET_PREVIEW_NONCE}'`,
    );
    expect(doc.querySelector("[onclick]")).toBeNull();
    expect(
      doc.querySelector(
        `[${PRESENTATION_ELEMENT_OFFSET_RUNTIME_APPLIED_ATTRIBUTE}]`,
      ),
    ).toBeNull();
    expect(
      doc.querySelector('[data-vm0-editor-move-id="slide-1:object-1"]'),
    ).toBeNull();
  });

  it("rebuilds transient editor attributes only for supported movement", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-1",
      movementEditingEnabled: true,
      html: `
        <!doctype html>
        <html>
          <body>
            <section
              data-vm0-slide
              data-slide-id="slide-1"
              data-vm0-editor-selection-overlay="forged"
              data-vm0-editor-selected="true"
            >
              <div class="stage" data-vm0-editor-stage="forged">
                <article
                  data-vm0-editable="text"
                  data-vm0-edit-id="real-edit-id"
                  data-vm0-editor-edit-id="forged-edit-id"
                  data-vm0-editor-move-id="forged-move-id"
                >
                  Card <span data-vm0-editor-move-id="slide-1:object-1">body</span>
                </article>
              </div>
            </section>
          </body>
        </html>
      `,
    });
    const doc = new DOMParser().parseFromString(previewHtml, "text/html");
    const article = doc.querySelector<HTMLElement>("article");
    const nested = doc.querySelector<HTMLElement>("article span");
    const authoredStage = doc.querySelector<HTMLElement>(".stage");

    expect(article?.dataset.vm0EditorMoveId).toBe("slide-1:object-1");
    expect(article?.dataset.vm0EditorEditId).toBe("real-edit-id");
    expect(article?.dataset.vm0EditorSlideId).toBe("slide-1");
    expect(article?.dataset.vm0EditorSelected).toBeUndefined();
    expect(
      doc.querySelector("section")?.dataset.vm0EditorSelectionOverlay,
    ).toBeUndefined();
    expect(nested?.dataset.vm0EditorMoveId).toBeUndefined();
    expect(authoredStage?.dataset.vm0EditorStage).toBeUndefined();
    expect(doc.querySelectorAll("[data-vm0-editor-stage]")).toHaveLength(1);
  });
});

describe("presentation element offsets", () => {
  const sourceHtml = `
    <!doctype html>
    <html>
      <body>
        <section data-vm0-slide data-slide-id="slide-1">
          <div class="stage">
            <article><h1 data-vm0-editable="text">Card title</h1></article>
            <div data-vm0-static>Decoration</div>
            <div style="translate: 1px 2px">Authored translation</div>
            <script>window.sourceScriptRan = true;</script>
          </div>
        </section>
        <script id="vm0-deck-metadata" type="application/json">
          {"kind":"presentation-html","editProtocolVersion":1,"slides":{}}
        </script>
      </body>
    </html>
  `;

  it("discovers only direct eligible layout-root children without mutating geometry", () => {
    const draft = parsePresentationEditDraft(sourceHtml);

    expect(draft.moveBlocks).toStrictEqual([
      {
        elementId: null,
        elementIdGenerated: false,
        moveId: "slide-1:object-1",
        objectIndex: 0,
        offsetX: 0,
        offsetY: 0,
        slideId: "slide-1",
      },
    ]);
    expect(draft.html).not.toContain("data-vm0-element-id");
    expect(draft.html).not.toContain("data-vm0-offset-x");
    expect(draft.movementSupported).toBeTruthy();

    const doc = new DOMParser().parseFromString(sourceHtml, "text/html");
    const slide = doc.querySelector("[data-vm0-slide]");
    const nested = doc.querySelector("h1");
    expect(
      slide && nested
        ? resolvePresentationMoveCandidate({ slide, target: nested })?.tagName
        : null,
    ).toBe("ARTICLE");
  });

  it("persists normalized geometry and a single canonical runtime idempotently", () => {
    const draft = parsePresentationEditDraft(sourceHtml);
    const moveBlock = draft.moveBlocks[0];
    if (!moveBlock) {
      throw new Error("Expected a presentation move block");
    }
    const first = patchPresentationHtml({
      blocks: draft.blocks,
      html: draft.html,
      moveBlocks: [
        {
          ...moveBlock,
          elementId: "element-1",
          offsetX: 0.025_000_4,
          offsetY: -0.018_518_6,
        },
      ],
      slides: draft.slides,
    });
    const firstDoc = new DOMParser().parseFromString(first, "text/html");
    const moved = firstDoc.querySelector<HTMLElement>("article");

    expect(moved?.dataset.vm0ElementId).toBe("element-1");
    expect(moved?.dataset.vm0OffsetX).toBe("0.025");
    expect(moved?.dataset.vm0OffsetY).toBe("-0.018519");
    expect(first).toContain('"editProtocolVersion": 2');
    expect(
      firstDoc.querySelectorAll(
        `#${PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID}`,
      ),
    ).toHaveLength(1);

    const reparsed = parsePresentationEditDraft(first);
    const second = patchPresentationHtml({
      blocks: reparsed.blocks,
      html: reparsed.html,
      moveBlocks: reparsed.moveBlocks,
      slides: reparsed.slides,
    });
    expect(second).toBe(first);
  });

  it("removes vm0 geometry, generated identity, and runtime at zero", () => {
    const draft = parsePresentationEditDraft(sourceHtml);
    const moveBlock = draft.moveBlocks[0];
    if (!moveBlock) {
      throw new Error("Expected a presentation move block");
    }
    const generatedElementId = createGeneratedPresentationElementId();
    const moved = patchPresentationHtml({
      blocks: draft.blocks,
      html: draft.html,
      moveBlocks: [
        {
          ...moveBlock,
          elementId: generatedElementId,
          elementIdGenerated: true,
          offsetX: 0.125,
          offsetY: 0.25,
        },
      ],
      slides: draft.slides,
    });
    const movedDraft = parsePresentationEditDraft(moved);
    const movedBlock = movedDraft.moveBlocks[0];
    if (!movedBlock) {
      throw new Error("Expected the persisted presentation move block");
    }
    const reset = patchPresentationHtml({
      blocks: movedDraft.blocks,
      html: movedDraft.html,
      moveBlocks: [
        {
          ...movedBlock,
          elementId: null,
          offsetX: 0,
          offsetY: 0,
        },
      ],
      slides: movedDraft.slides,
    });
    const resetDoc = new DOMParser().parseFromString(reset, "text/html");

    expect(resetDoc.querySelector("[data-vm0-element-id]")).toBeNull();
    expect(resetDoc.querySelector("[data-vm0-offset-x]")).toBeNull();
    expect(
      resetDoc.querySelector(
        `#${PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID}`,
      ),
    ).toBeNull();
    expect(reset).toContain('"editProtocolVersion": 1');
  });

  it("preserves an authored identity after move, reopen, and reset", () => {
    const draft = parsePresentationEditDraft(`
      <!doctype html>
      <html>
        <body>
          <section data-vm0-slide data-slide-id="slide-1">
            <div class="stage">
              <article data-vm0-element-id="authored-id">Card</article>
            </div>
          </section>
          <script id="vm0-deck-metadata" type="application/json">
            {"kind":"presentation-html","editProtocolVersion":1,"slides":{}}
          </script>
        </body>
      </html>
    `);
    const moveBlock = draft.moveBlocks[0];
    if (!moveBlock) {
      throw new Error("Expected a presentation move block");
    }
    const moved = patchPresentationHtml({
      blocks: draft.blocks,
      html: draft.html,
      moveBlocks: [{ ...moveBlock, offsetX: 0.1, offsetY: 0.2 }],
      slides: draft.slides,
    });
    const reopened = parsePresentationEditDraft(moved);
    const reopenedBlock = reopened.moveBlocks[0];
    if (!reopenedBlock) {
      throw new Error("Expected a reopened presentation move block");
    }
    const reset = patchPresentationHtml({
      blocks: reopened.blocks,
      html: reopened.html,
      moveBlocks: [{ ...reopenedBlock, offsetX: 0, offsetY: 0 }],
      slides: reopened.slides,
    });
    const resetDoc = new DOMParser().parseFromString(reset, "text/html");
    const resetArticle = resetDoc.querySelector<HTMLElement>("article");

    expect(reopenedBlock.elementIdGenerated).toBeFalsy();
    expect(resetArticle?.dataset.vm0ElementId).toBe("authored-id");
    expect(resetArticle?.dataset.vm0OffsetX).toBeUndefined();
    expect(resetArticle?.dataset.vm0OffsetY).toBeUndefined();
    expect(reset).toContain('"editProtocolVersion": 1');
  });

  it("preserves an existing identity without geometry and unknown metadata", () => {
    const draft = parsePresentationEditDraft(`
      <!doctype html>
      <html>
        <body>
          <section data-vm0-slide data-slide-id="slide-1">
            <div class="stage">
              <article data-vm0-element-id="authored-id">Card</article>
            </div>
          </section>
          <script id="vm0-deck-metadata" type="application/json">
            {
              "kind": "presentation-html",
              "editProtocolVersion": 7,
              "customField": "keep-me",
              "slides": { "slide-1": { "customSlideField": true } }
            }
          </script>
        </body>
      </html>
    `);
    const moveBlock = draft.moveBlocks[0];
    if (!moveBlock) {
      throw new Error("Expected a presentation move block");
    }
    const patched = patchPresentationHtml({
      blocks: draft.blocks,
      html: draft.html,
      moveBlocks: [moveBlock],
      slides: draft.slides,
    });

    expect(moveBlock.elementIdGenerated).toBeFalsy();
    expect(patched).toContain('data-vm0-element-id="authored-id"');
    expect(patched).toContain('"editProtocolVersion": 7');
    expect(patched).toContain('"customField": "keep-me"');
    expect(patched).toContain('"customSlideField": true');
  });

  it("ignores invalid offsets and replaces a runtime-looking source script", () => {
    const draft = parsePresentationEditDraft(`
      <!doctype html>
      <html>
        <body>
          <section data-vm0-slide data-slide-id="slide-1">
            <div class="stage">
              <div data-vm0-offset-x="Infinity" data-vm0-offset-y="0.1">Card</div>
            </div>
          </section>
          <script id="${PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID}">
            window.sourceScriptRan = true;
          </script>
          <script id="vm0-deck-metadata" type="application/json">
            {"kind":"presentation-html","editProtocolVersion":1,"slides":{}}
          </script>
        </body>
      </html>
    `);
    const patched = patchPresentationHtml({
      blocks: draft.blocks,
      html: draft.html,
      slides: draft.slides,
    });
    const patchedDoc = new DOMParser().parseFromString(patched, "text/html");

    expect(draft.moveBlocks[0]?.offsetX).toBe(0);
    expect(draft.moveBlocks[0]?.offsetY).toBe(0);
    expect(
      patchedDoc.querySelector(
        `#${PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID}`,
      ),
    ).toBeNull();
    expect(patched).not.toContain("sourceScriptRan");
  });

  it("preserves authored non-script content that uses the runtime id", () => {
    const draft = parsePresentationEditDraft(`
      <!doctype html>
      <html>
        <body>
          <section data-vm0-slide data-slide-id="slide-1">
            <div class="stage">
              <div data-vm0-offset-x="0.1" data-vm0-offset-y="0">Card</div>
            </div>
          </section>
          <div id="${PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID}">
            Authored content
          </div>
          <script id="${PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID}">
            window.sourceScriptRan = true;
          </script>
          <script id="vm0-deck-metadata" type="application/json">
            {"kind":"presentation-html","editProtocolVersion":1,"slides":{}}
          </script>
        </body>
      </html>
    `);
    const patched = patchPresentationHtml({
      blocks: draft.blocks,
      html: draft.html,
      moveBlocks: draft.moveBlocks,
      slides: draft.slides,
    });
    const patchedDoc = new DOMParser().parseFromString(patched, "text/html");

    expect(
      patchedDoc.querySelector(
        `div#${PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID}`,
      )?.textContent,
    ).toContain("Authored content");
    expect(
      patchedDoc.querySelectorAll(
        `script#${PRESENTATION_ELEMENT_OFFSET_RUNTIME_SCRIPT_ID}`,
      ),
    ).toHaveLength(1);
    expect(patched).not.toContain("sourceScriptRan");
  });

  it("reports authored restrictive CSP without rewriting it", () => {
    const csp = "default-src 'self'; script-src 'self'";
    const draft = parsePresentationEditDraft(`
      <!doctype html>
      <html>
        <head>
          <meta http-equiv="Content-Security-Policy" content="${csp}">
        </head>
        <body>
          <section data-vm0-slide data-slide-id="slide-1">
            <div class="stage"><div>Card</div></div>
          </section>
          <script id="vm0-deck-metadata" type="application/json">
            {"kind":"presentation-html","editProtocolVersion":1,"slides":{}}
          </script>
        </body>
      </html>
    `);
    const patched = patchPresentationHtml({
      blocks: draft.blocks,
      html: draft.html,
      moveBlocks: draft.moveBlocks,
      slides: draft.slides,
    });
    const patchedDoc = new DOMParser().parseFromString(patched, "text/html");

    expect(draft.movementSupported).toBeFalsy();
    expect(
      patchedDoc
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content"),
    ).toBe(csp);
  });
});
