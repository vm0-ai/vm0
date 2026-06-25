import { describe, expect, it } from "vitest";
import {
  createHtmlDomEditPayload,
  HTML_DOM_EDIT_OVERLAY_ATTR,
  HTML_DOM_EDIT_PAYLOAD_TYPE,
  HTML_DOM_EDIT_TEMP_BASE_ATTR,
  HTML_DOM_NODE_ID_ATTR,
  instrumentHtmlDomEditWorkingCopy,
  stripHtmlDomEditInstrumentation,
} from "../html-dom-edit-protocol.ts";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function nodeIds(doc: Document): string[] {
  return Array.from(doc.querySelectorAll(`[${HTML_DOM_NODE_ID_ATTR}]`)).map(
    (element) => {
      return element.getAttribute(HTML_DOM_NODE_ID_ATTR) ?? "";
    },
  );
}

describe("instrumentHtmlDomEditWorkingCopy", () => {
  it("injects unique node ids into selectable HTML elements", () => {
    const result = instrumentHtmlDomEditWorkingCopy({
      html: `
        <!doctype html>
        <html>
          <head><title>Landing</title></head>
          <body>
            <main class="page" data-existing="keep">
              <section>
                <h1>Launch faster</h1>
                <p>Ship the first version today.</p>
                <img alt="Preview" src="/hero.png">
                <a href="/signup">Start</a>
              </section>
            </main>
          </body>
        </html>
      `,
      nodeIdPrefix: "test-node",
    });
    const doc = parse(result.html);
    const ids = nodeIds(doc);

    expect(result.html).toContain("<!doctype html>");
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      ids.every((id) => {
        return id.startsWith("test-node-");
      }),
    ).toBeTruthy();
    expect(doc.querySelector("main")?.dataset.existing).toBe("keep");
    expect(doc.querySelector("h1")?.getAttribute(HTML_DOM_NODE_ID_ATTR)).toBe(
      "test-node-3",
    );
    expect(
      doc.querySelector("img")?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
    ).toBeTruthy();
  });

  it("skips scripts, styles, hidden content, and comment-mode overlays", () => {
    const result = instrumentHtmlDomEditWorkingCopy({
      html: `
        <main>
          <style>.hidden { display: none; }</style>
          <script>window.vm0 = true;</script>
          <h1>Visible</h1>
          <p hidden>Hidden attr</p>
          <p aria-hidden="true">Aria hidden</p>
          <p style="display: none">Display none</p>
          <div style="visibility: hidden"><span>Visibility hidden</span></div>
          <aside ${HTML_DOM_EDIT_OVERLAY_ATTR}>Comment panel</aside>
        </main>
      `,
    });
    const doc = parse(result.html);

    expect(
      doc.querySelector("script")?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
    ).toBeFalsy();
    expect(
      doc.querySelector("style")?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
    ).toBeFalsy();
    expect(
      doc.querySelector("[hidden]")?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
    ).toBeFalsy();
    expect(
      doc
        .querySelector('[aria-hidden="true"]')
        ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
    ).toBeFalsy();
    expect(doc.querySelector("aside")).toBeNull();
    expect(
      doc.querySelector("h1")?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
    ).toBeTruthy();
  });

  it("removes stale node ids before assigning fresh ids", () => {
    const result = instrumentHtmlDomEditWorkingCopy({
      html: `
        <main ${HTML_DOM_NODE_ID_ATTR}="stale-main">
          <h1 ${HTML_DOM_NODE_ID_ATTR}="stale-title">Title</h1>
        </main>
      `,
    });
    const doc = parse(result.html);

    expect(result.nodeIds).toStrictEqual(["vm0-node-1", "vm0-node-2"]);
    expect(doc.querySelector("main")?.getAttribute(HTML_DOM_NODE_ID_ATTR)).toBe(
      "vm0-node-1",
    );
    expect(doc.body.innerHTML).not.toContain("stale-title");
  });

  it("can inject a temporary base href for relative assets", () => {
    const result = instrumentHtmlDomEditWorkingCopy({
      baseHref: "https://example.com/site/",
      html: `<html><head></head><body><img src="./asset.png"></body></html>`,
    });
    const doc = parse(result.html);
    const base = doc.querySelector("base");

    expect(base?.href).toBe("https://example.com/site/");
    expect(base?.hasAttribute(HTML_DOM_EDIT_TEMP_BASE_ATTR)).toBeTruthy();
  });
});

describe("stripHtmlDomEditInstrumentation", () => {
  it("removes VM0 edit metadata and overlay nodes", () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <base href="https://example.com/" ${HTML_DOM_EDIT_TEMP_BASE_ATTR}>
        </head>
        <body>
          <main ${HTML_DOM_NODE_ID_ATTR}="vm0-node-1">
            <h1 ${HTML_DOM_NODE_ID_ATTR}="vm0-node-2">Title</h1>
            <div ${HTML_DOM_EDIT_OVERLAY_ATTR}>Editor UI</div>
          </main>
        </body>
      </html>
    `;
    const stripped = stripHtmlDomEditInstrumentation(html);

    expect(stripped).toContain("<!doctype html>");
    expect(stripped).not.toContain(HTML_DOM_NODE_ID_ATTR);
    expect(stripped).not.toContain(HTML_DOM_EDIT_OVERLAY_ATTR);
    expect(stripped).not.toContain(HTML_DOM_EDIT_TEMP_BASE_ATTR);
    expect(stripped).toContain("<h1>Title</h1>");
  });
});

describe("createHtmlDomEditPayload", () => {
  it("creates the V1 hidden agent payload shape", () => {
    expect(
      createHtmlDomEditPayload({
        originalUrl: "https://example.com/original",
        workingCopyUrl: "https://cdn.example.com/working-copy.html",
        comments: [
          {
            id: "comment-1",
            targetNodeIds: ["vm0-node-1"],
            comment: "Make this clearer",
            selectedText: "Launch",
          },
        ],
      }),
    ).toStrictEqual({
      type: HTML_DOM_EDIT_PAYLOAD_TYPE,
      originalUrl: "https://example.com/original",
      workingCopyUrl: "https://cdn.example.com/working-copy.html",
      comments: [
        {
          id: "comment-1",
          targetNodeIds: ["vm0-node-1"],
          comment: "Make this clearer",
          selectedText: "Launch",
        },
      ],
    });
  });
});
