import { afterEach, describe, expect, it, vi } from "vitest";

describe("Worker entrypoint", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "DOMParser");
    Reflect.deleteProperty(globalThis, "Node");
    vi.resetModules();
  });

  it("installs the XML DOM globals required by the browser S3 client", async () => {
    Reflect.deleteProperty(globalThis, "DOMParser");
    Reflect.deleteProperty(globalThis, "Node");
    vi.resetModules();

    await import("../worker");
    const xmlDom = await import("@xmldom/xmldom");

    expect(
      Object.getOwnPropertyDescriptor(globalThis, "DOMParser")?.value,
    ).toBe(xmlDom.DOMParser);
    expect(Object.getOwnPropertyDescriptor(globalThis, "Node")?.value).toBe(
      xmlDom.Node,
    );
    const document = new xmlDom.DOMParser().parseFromString(
      "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
      "application/xml",
    );
    expect(document.documentElement?.nodeName).toBe("ListBucketResult");
    expect(document.documentElement?.nodeType).toBe(xmlDom.Node.ELEMENT_NODE);
  });
});
