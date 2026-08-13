import { beforeAll, describe, expect, it, vi } from "vitest";

import { renderPptx } from "../pptx-renderer.ts";

const pptxXml = vi.hoisted(() => {
  return {
    contentTypes: "",
  };
});

vi.mock("@aiden0z/pptx-renderer", () => {
  return {
    parseZipLazyMedia() {
      return Promise.resolve({
        contentTypes: pptxXml.contentTypes,
        presentation: "",
        presentationRels: "",
      });
    },
    buildPresentation() {
      return { height: 900, slides: [{}], width: 1600 };
    },
    renderSlide() {
      return {
        dispose() {},
        element: document.createElement("div"),
        ready: Promise.resolve(),
      };
    },
  };
});

vi.mock("modern-screenshot", () => {
  return {
    domToBlob() {
      return Promise.resolve(new Blob(["png"], { type: "image/png" }));
    },
    waitUntilLoad() {
      return Promise.resolve();
    },
  };
});

function connectedTarget(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  return target;
}

beforeAll(() => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
});

describe("pptx ignored content", () => {
  it("allows media, animation, transition, and 3D metadata", async () => {
    pptxXml.contentTypes = [
      "<p:videoFile/>",
      "<p:audioFile/>",
      "<p:timing/>",
      "<p:transition/>",
      "<a:scene3d/>",
      "<c:bar3DChart/>",
      '<Override PartName="/ppt/media/image1.wmf" ContentType="image/x-wmf"/>',
    ].join("");
    const target = connectedTarget();

    const session = await renderPptx(
      {
        source: {
          data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
          filename: "ignored-content.pptx",
        },
        target,
      },
      AbortSignal.any([]),
    );

    expect(session.pageCount).toBe(1);
    session.dispose();
    target.remove();
  });

  it("keeps a typed failure for silently omitted equations", async () => {
    pptxXml.contentTypes = "<m:oMath>";
    const target = connectedTarget();

    await expect(
      renderPptx(
        {
          source: {
            data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
            filename: "equation.pptx",
          },
          target,
        },
        AbortSignal.any([]),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_content",
      feature: "equation",
    });
    expect(target.childElementCount).toBe(0);
    target.remove();
  });

  it("keeps a typed failure for EMF content that can render blank", async () => {
    pptxXml.contentTypes =
      '<Override PartName="/ppt/media/image1.emf" ContentType="image/x-emf"/>';
    const target = connectedTarget();

    await expect(
      renderPptx(
        {
          source: {
            data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
            filename: "emf.pptx",
          },
          target,
        },
        AbortSignal.any([]),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_content",
      feature: "emf",
    });
    expect(target.childElementCount).toBe(0);
    target.remove();
  });
});
