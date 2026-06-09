import { describe, expect, it } from "vitest";
import {
  parsePresentationEditDraft,
  patchPresentationHtml,
  previewPresentationHtml,
} from "../presentation-html-edit-protocol.ts";

const html = `
  <!doctype html>
  <html>
    <head><title>Deck</title></head>
    <body>
      <section class="slide" data-slide-id="slide-1">
        <h1 data-vm0-editable="text" data-edit-id="title">Old title</h1>
        <p data-vm0-editable="text" data-edit-id="subtitle">Old subtitle</p>
        <img src="cat.png" alt="Cat" />
      </section>
      <section class="slide" data-slide-id="slide-2">
        <h2 data-vm0-editable="text" data-edit-id="title">Second</h2>
      </section>
      <script type="application/json" id="vm0-deck-metadata">
        {
          "kind": "presentation-html",
          "editProtocolVersion": 1,
          "slides": {
            "slide-1": { "speakerNotes": "Old notes" }
          }
        }
      </script>
    </body>
  </html>
`;

describe("presentation HTML edit protocol", () => {
  it("parses editable text blocks and speaker notes", () => {
    const draft = parsePresentationEditDraft(html);

    expect(draft.slides).toStrictEqual([
      { id: "slide-1", title: "Old title", notes: "Old notes" },
      { id: "slide-2", title: "Second", notes: "" },
    ]);
    expect(draft.blocks).toStrictEqual([
      {
        editId: "title",
        slideId: "slide-1",
        tagName: "h1",
        text: "Old title",
      },
      {
        editId: "subtitle",
        slideId: "slide-1",
        tagName: "p",
        text: "Old subtitle",
      },
      {
        editId: "title",
        slideId: "slide-2",
        tagName: "h2",
        text: "Second",
      },
    ]);
  });

  it("adds stable edit ids to editable text without overwriting existing ids", () => {
    const draft = parsePresentationEditDraft(`
      <!doctype html>
      <html>
        <body>
          <section class="slide" data-slide-id="slide-1">
            <h1>Generated title</h1>
            <p data-vm0-edit-id="existing-body">Generated body</p>
          </section>
        </body>
      </html>
    `);

    expect(draft.blocks).toStrictEqual([
      {
        editId: "text-1",
        slideId: "slide-1",
        tagName: "h1",
        text: "Generated title",
      },
      {
        editId: "existing-body",
        slideId: "slide-1",
        tagName: "p",
        text: "Generated body",
      },
    ]);
    expect(draft.html).toContain('<h1 data-vm0-edit-id="text-1">');
    expect(draft.html).toContain(
      '<p data-vm0-edit-id="existing-body">Generated body</p>',
    );
  });

  it("patches text through textContent and writes speaker notes metadata", () => {
    const draft = parsePresentationEditDraft(html);
    const patched = patchPresentationHtml({
      html: draft.html,
      blocks: draft.blocks.map((block) => {
        if (block.slideId === "slide-1" && block.editId === "title") {
          return { ...block, text: "New <unsafe> title" };
        }
        return block;
      }),
      slides: draft.slides.map((slide) => {
        if (slide.id === "slide-2") {
          return { ...slide, notes: "Second slide notes" };
        }
        return slide;
      }),
    });

    expect(patched).toContain("New &lt;unsafe&gt; title");
    expect(patched).toContain('"speakerNotes": "Second slide notes"');
    expect(patched).toContain('"kind": "presentation-html"');
  });

  it("preserves nested markup in unchanged editable blocks", () => {
    const htmlWithFormatting = `
      <!doctype html>
      <html>
        <body>
          <section class="slide" data-slide-id="slide-1">
            <h1 data-vm0-editable="text" data-edit-id="title"><em>Styled</em> title</h1>
            <p data-vm0-editable="text" data-edit-id="subtitle">Plain subtitle</p>
          </section>
        </body>
      </html>
    `;
    const draft = parsePresentationEditDraft(htmlWithFormatting);
    const patched = patchPresentationHtml({
      html: draft.html,
      blocks: draft.blocks.map((block) => {
        if (block.editId === "subtitle") {
          return { ...block, text: "New subtitle" };
        }
        return block;
      }),
      slides: draft.slides,
    });

    expect(patched).toContain("<em>Styled</em> title");
    expect(patched).toContain("New subtitle");
  });

  it("keeps executable markup when saving patched HTML", () => {
    const htmlWithRuntime = `
      <!doctype html>
      <html>
        <head>
          <script src="./runtime.js"></script>
        </head>
        <body>
          <section class="slide" data-slide-id="slide-1">
            <h1 data-vm0-editable="text" data-edit-id="title">Old title</h1>
          </section>
        </body>
      </html>
    `;
    const draft = parsePresentationEditDraft(htmlWithRuntime);
    const patched = patchPresentationHtml({
      html: draft.html,
      blocks: draft.blocks.map((block) => {
        return { ...block, text: "New title" };
      }),
      slides: draft.slides,
    });

    expect(patched).toContain('<script src="./runtime.js"></script>');
    expect(patched).toContain("New title");
  });

  it("creates a preview that shows only the active slide", () => {
    const preview = previewPresentationHtml({
      activeSlideId: "slide-2",
      html,
    });

    expect(preview).toContain('data-vm0-editor-edit-id="title"');
    expect(preview).toContain("Second");
  });

  it("removes script execution hooks from preview HTML", () => {
    const preview = previewPresentationHtml({
      activeSlideId: "slide-1",
      html: `
        <!doctype html>
        <html>
          <head>
            <script>window.bad = true</script>
          </head>
          <body>
            <section class="slide" data-slide-id="slide-1">
              <img src="cat.png" onerror="window.bad = true" />
              <a href="javascript:window.bad = true">Link</a>
              <a href="java&#10;script:window.bad = true">Obfuscated link</a>
              <a href="vbscript:window.bad = true">Legacy link</a>
              <img src="data:text/html,<script>window.bad = true</script>" />
              <object data="bad.html"></object>
              <embed src="bad.html" />
              <noscript><script>window.bad = true</script></noscript>
            </section>
          </body>
        </html>
      `,
    });

    expect(preview).not.toContain("<script");
    expect(preview).not.toContain("onerror=");
    expect(preview).not.toContain("javascript:");
    expect(preview).not.toContain("vbscript:");
    expect(preview).not.toContain("data:text/html");
    expect(preview).not.toContain("<object");
    expect(preview).not.toContain("<embed");
    expect(preview).not.toContain("<noscript");
    expect(preview).toContain("script-src 'none'");
  });
});
