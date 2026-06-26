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

interface ParsedStartTag {
  readonly source: string;
  readonly tagName: string;
}

function isWhitespaceChar(char: string | undefined): boolean {
  return (
    char === " " ||
    char === "\n" ||
    char === "\r" ||
    char === "\t" ||
    char === "\f"
  );
}

function isTagNameStartChar(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= "A" && char <= "Z") || (char >= "a" && char <= "z"))
  );
}

function isTagNameChar(char: string | undefined): boolean {
  return (
    isTagNameStartChar(char) ||
    (char !== undefined && char >= "0" && char <= "9") ||
    char === ":" ||
    char === "-" ||
    char === "_"
  );
}

function isAttributeNameChar(char: string | undefined): boolean {
  return (
    char !== undefined &&
    !isWhitespaceChar(char) &&
    char !== "=" &&
    char !== "/" &&
    char !== ">"
  );
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return index;
    }
  }
  return -1;
}

function parseStartTagSource(tagSource: string): ParsedStartTag | null {
  let index = 1;
  while (isWhitespaceChar(tagSource[index])) {
    index += 1;
  }
  if (tagSource[index] === "/") {
    return null;
  }
  if (!isTagNameStartChar(tagSource[index])) {
    return null;
  }

  const nameStart = index;
  index += 1;
  while (isTagNameChar(tagSource[index])) {
    index += 1;
  }

  return {
    source: tagSource,
    tagName: tagSource.slice(nameStart, index),
  };
}

function startTagAttributeValue(
  tagSource: string,
  attributeName: string,
): string | null {
  const parsed = parseStartTagSource(tagSource);
  if (!parsed) {
    return null;
  }

  let index = 1 + parsed.tagName.length;
  while (index < tagSource.length) {
    while (isWhitespaceChar(tagSource[index])) {
      index += 1;
    }
    if (tagSource[index] === "/" || tagSource[index] === ">") {
      return null;
    }

    const nameStart = index;
    while (isAttributeNameChar(tagSource[index])) {
      index += 1;
    }
    const name = tagSource.slice(nameStart, index);
    while (isWhitespaceChar(tagSource[index])) {
      index += 1;
    }

    let value = "";
    if (tagSource[index] === "=") {
      index += 1;
      while (isWhitespaceChar(tagSource[index])) {
        index += 1;
      }
      const quote = tagSource[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < tagSource.length && tagSource[index] !== quote) {
          index += 1;
        }
        value = tagSource.slice(valueStart, index);
        if (tagSource[index] === quote) {
          index += 1;
        }
      } else {
        const valueStart = index;
        while (
          index < tagSource.length &&
          !isWhitespaceChar(tagSource[index]) &&
          tagSource[index] !== ">"
        ) {
          index += 1;
        }
        value = tagSource.slice(valueStart, index);
      }
    }

    if (name === attributeName) {
      return value;
    }
  }

  return null;
}

function startTags(html: string): ParsedStartTag[] {
  const tags: ParsedStartTag[] = [];
  let searchStart = 0;
  while (searchStart < html.length) {
    const start = html.indexOf("<", searchStart);
    if (start === -1) {
      return tags;
    }
    const end = findTagEnd(html, start);
    if (end === -1) {
      return tags;
    }
    const parsed = parseStartTagSource(html.slice(start, end + 1));
    if (parsed) {
      tags.push(parsed);
    }
    searchStart = end + 1;
  }
  return tags;
}

function startTagsByTagName(html: string, tagName: string): ParsedStartTag[] {
  const normalizedTagName = tagName.toLowerCase();
  return startTags(html).filter((tag) => {
    return tag.tagName.toLowerCase() === normalizedTagName;
  });
}

function nodeIds(html: string): string[] {
  return startTags(html)
    .map((tag) => {
      return startTagAttributeValue(tag.source, HTML_DOM_NODE_ID_ATTR);
    })
    .filter((value): value is string => {
      return value !== null;
    });
}

function elementHasAttribute(
  html: string,
  tagName: string,
  attribute: string,
): boolean {
  return startTagsByTagName(html, tagName).some((tag) => {
    return startTagAttributeValue(tag.source, attribute) !== null;
  });
}

function elementHasAttributeValue(
  html: string,
  tagName: string,
  attribute: string,
  value: string,
): boolean {
  return startTagsByTagName(html, tagName).some((tag) => {
    return startTagAttributeValue(tag.source, attribute) === value;
  });
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
      startTagsByTagName(result.html, "p").some((tag) => {
        return (
          startTagAttributeValue(tag.source, "hidden") !== null &&
          startTagAttributeValue(tag.source, HTML_DOM_NODE_ID_ATTR) !== null
        );
      }),
    ).toBeFalsy();
    expect(
      startTagsByTagName(result.html, "p").some((tag) => {
        return (
          startTagAttributeValue(tag.source, "aria-hidden") === "true" &&
          startTagAttributeValue(tag.source, HTML_DOM_NODE_ID_ATTR) !== null
        );
      }),
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
