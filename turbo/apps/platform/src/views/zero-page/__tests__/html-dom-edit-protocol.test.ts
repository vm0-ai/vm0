import { describe, expect, it } from "vitest";
import {
  createHtmlDomEditPayload,
  HTML_DOM_EDIT_OVERLAY_ATTR,
  HTML_DOM_EDIT_PAYLOAD_TYPE,
  HTML_DOM_EDIT_HOVER_ATTR,
  HTML_DOM_EDIT_SELECTED_ATTR,
  HTML_DOM_EDIT_TEMP_BASE_ATTR,
  HTML_DOM_NODE_ID_ATTR,
  instrumentHtmlDomEditDocument,
  stripHtmlDomEditOverlays,
  stripHtmlDomEditInstrumentation,
} from "../html-dom-edit-protocol.ts";

function nodeIds(html: string): string[] {
  return Array.from(
    html.matchAll(new RegExp(`${HTML_DOM_NODE_ID_ATTR}="([^"]+)"`, "gu")),
  ).map((match) => {
    return match[1] ?? "";
  });
}

function elementHasAttribute(
  html: string,
  tagName: string,
  attribute: string,
): boolean {
  return new RegExp(
    `<${tagName}\\b(?=[^>]*\\b${attribute}\\b)[^>]*>`,
    "iu",
  ).test(html);
}

function elementHasAttributeValue(
  html: string,
  tagName: string,
  attribute: string,
  value: string,
): boolean {
  return new RegExp(
    `<${tagName}\\b(?=[^>]*\\b${attribute}="${value}")[^>]*>`,
    "iu",
  ).test(html);
}

describe("instrumentHtmlDomEditDocument", () => {
  it("injects unique node ids into selectable HTML elements", () => {
    const result = instrumentHtmlDomEditDocument({
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
    const ids = nodeIds(result.html);

    expect(result.html).toContain("<!doctype html>");
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      ids.every((id) => {
        return id.startsWith("test-node-");
      }),
    ).toBeTruthy();
    expect(
      elementHasAttributeValue(result.html, "main", "data-existing", "keep"),
    ).toBeTruthy();
    expect(
      elementHasAttributeValue(
        result.html,
        "h1",
        HTML_DOM_NODE_ID_ATTR,
        "test-node-3",
      ),
    ).toBeTruthy();
    expect(
      elementHasAttribute(result.html, "img", HTML_DOM_NODE_ID_ATTR),
    ).toBeTruthy();
  });

  it("skips scripts, styles, hidden content, and comment-mode overlays", () => {
    const result = instrumentHtmlDomEditDocument({
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

    expect(
      elementHasAttribute(result.html, "script", HTML_DOM_NODE_ID_ATTR),
    ).toBeFalsy();
    expect(
      elementHasAttribute(result.html, "style", HTML_DOM_NODE_ID_ATTR),
    ).toBeFalsy();
    expect(
      elementHasAttribute(
        result.html,
        "p",
        `hidden[^>]*${HTML_DOM_NODE_ID_ATTR}`,
      ),
    ).toBeFalsy();
    expect(
      new RegExp(
        `<p\\b(?=[^>]*\\baria-hidden="true")(?=[^>]*\\b${HTML_DOM_NODE_ID_ATTR}\\b)[^>]*>`,
        "iu",
      ).test(result.html),
    ).toBeFalsy();
    expect(result.html).not.toContain("<aside");
    expect(
      elementHasAttribute(result.html, "h1", HTML_DOM_NODE_ID_ATTR),
    ).toBeTruthy();
  });

  it("removes stale node ids before assigning fresh ids", () => {
    const result = instrumentHtmlDomEditDocument({
      html: `
        <main ${HTML_DOM_NODE_ID_ATTR}="stale-main">
          <h1 ${HTML_DOM_NODE_ID_ATTR}="stale-title">Title</h1>
        </main>
      `,
    });

    expect(result.nodeIds).toStrictEqual(["vm0-node-1", "vm0-node-2"]);
    expect(
      elementHasAttributeValue(
        result.html,
        "main",
        HTML_DOM_NODE_ID_ATTR,
        "vm0-node-1",
      ),
    ).toBeTruthy();
    expect(result.html).not.toContain("stale-title");
  });

  it("can inject a temporary base href for relative assets", () => {
    const result = instrumentHtmlDomEditDocument({
      baseHref: "https://example.com/site/",
      html: `<html><head></head><body><img src="./asset.png"></body></html>`,
    });

    expect(
      elementHasAttributeValue(
        result.html,
        "base",
        "href",
        "https://example.com/site/",
      ),
    ).toBeTruthy();
    expect(
      elementHasAttribute(result.html, "base", HTML_DOM_EDIT_TEMP_BASE_ATTR),
    ).toBeTruthy();
  });
});

describe("stripHtmlDomEditInstrumentation", () => {
  it("removes overlay nodes while keeping node ids for agent targeting", () => {
    const html = `
      <!doctype html>
      <html>
        <body>
          <main ${HTML_DOM_NODE_ID_ATTR}="vm0-node-1" ${HTML_DOM_EDIT_SELECTED_ATTR}="true">
            <h1 ${HTML_DOM_NODE_ID_ATTR}="vm0-node-2">Title</h1>
          </main>
          <div ${HTML_DOM_EDIT_OVERLAY_ATTR}>Comment tags</div>
        </body>
      </html>
    `;
    const stripped = stripHtmlDomEditOverlays(html);

    expect(stripped).toContain(`${HTML_DOM_NODE_ID_ATTR}="vm0-node-1"`);
    expect(stripped).toContain(`${HTML_DOM_NODE_ID_ATTR}="vm0-node-2"`);
    expect(stripped).not.toContain(HTML_DOM_EDIT_OVERLAY_ATTR);
    expect(stripped).not.toContain(HTML_DOM_EDIT_SELECTED_ATTR);
  });

  it("removes VM0 edit metadata and overlay nodes", () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <base href="https://example.com/" ${HTML_DOM_EDIT_TEMP_BASE_ATTR}>
        </head>
        <body>
          <main ${HTML_DOM_NODE_ID_ATTR}="vm0-node-1" ${HTML_DOM_EDIT_SELECTED_ATTR}="true">
            <h1 ${HTML_DOM_NODE_ID_ATTR}="vm0-node-2" ${HTML_DOM_EDIT_HOVER_ATTR}="true">Title</h1>
            <div ${HTML_DOM_EDIT_OVERLAY_ATTR}>Editor UI</div>
          </main>
        </body>
      </html>
    `;
    const stripped = stripHtmlDomEditInstrumentation(html);

    expect(stripped).toContain("<!doctype html>");
    expect(stripped).not.toContain(HTML_DOM_NODE_ID_ATTR);
    expect(stripped).not.toContain(HTML_DOM_EDIT_OVERLAY_ATTR);
    expect(stripped).not.toContain(HTML_DOM_EDIT_HOVER_ATTR);
    expect(stripped).not.toContain(HTML_DOM_EDIT_SELECTED_ATTR);
    expect(stripped).not.toContain(HTML_DOM_EDIT_TEMP_BASE_ATTR);
    expect(stripped).toContain("<h1>Title</h1>");
  });
});

describe("createHtmlDomEditPayload", () => {
  it("creates the hidden agent payload shape", () => {
    expect(
      createHtmlDomEditPayload({
        editRequestId: "edit-request-1",
        htmlSnapshotUrl: "https://cdn.example.com/snapshot.html",
        comments: [
          {
            id: "comment-1",
            targetNodeIds: ["vm0-node-1"],
            comment: "Make this clearer",
          },
        ],
      }),
    ).toStrictEqual({
      type: HTML_DOM_EDIT_PAYLOAD_TYPE,
      editRequestId: "edit-request-1",
      htmlSnapshotUrl: "https://cdn.example.com/snapshot.html",
      comments: [
        {
          id: "comment-1",
          targetNodeIds: ["vm0-node-1"],
          comment: "Make this clearer",
        },
      ],
    });
  });
});
