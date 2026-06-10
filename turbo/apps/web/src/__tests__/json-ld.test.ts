import { describe, expect, it } from "vitest";
import { serializeJsonLd } from "../lib/json-ld";

describe("serializeJsonLd", () => {
  it("escapes script-breaking and HTML-significant characters", () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);
    const payload = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      name: `</script><img src=x onerror=alert(1)> & ${lineSeparator}${paragraphSeparator}`,
    };

    const serialized = serializeJsonLd(payload);

    expect(serialized).toContain("\\u003c/script\\u003e");
    expect(serialized).toContain("\\u003cimg src=x onerror=alert(1)\\u003e");
    expect(serialized).toContain("\\u0026");
    expect(serialized).toContain("\\u2028");
    expect(serialized).toContain("\\u2029");
    expect(serialized).not.toContain("</script>");
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain(">");
    expect(serialized).not.toContain("&");
    expect(serialized).not.toContain(lineSeparator);
    expect(serialized).not.toContain(paragraphSeparator);
    expect(JSON.parse(serialized)).toStrictEqual(payload);
  });

  it("keeps existing structured data semantics unchanged", () => {
    const payload = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "VM0",
      sameAs: ["https://github.com/vm0-ai/vm0"],
      contactPoint: {
        "@type": "ContactPoint",
        email: "support@vm0.ai",
      },
    };

    expect(serializeJsonLd(payload)).toBe(JSON.stringify(payload));
  });
});
