import { describe, it, expect } from "vitest";
import { ZERO_CAPABILITIES, ZERO_CAPABILITY_META } from "../capabilities";

describe("ZERO_CAPABILITIES", () => {
  it("should have exactly 41 capabilities", () => {
    expect(ZERO_CAPABILITIES).toHaveLength(41);
  });

  it("should follow {resource}:{action} naming pattern", () => {
    for (const cap of ZERO_CAPABILITIES) {
      expect(cap).toMatch(/^[a-z-]+(?::[a-z-]+)?:(read|write|delete)$/);
    }
  });

  it("should not include artifact capabilities", () => {
    expect(ZERO_CAPABILITIES).not.toContain("artifact:read");
    expect(ZERO_CAPABILITIES).not.toContain("artifact:write");
  });

  it("should use slack:write not integration-slack:write", () => {
    expect(ZERO_CAPABILITIES).toContain("slack:write");
    expect(ZERO_CAPABILITIES).not.toContain("integration-slack:write");
  });

  it("should include Feishu messaging capability", () => {
    expect(ZERO_CAPABILITIES).toContain("feishu:write");
  });

  it("should include telegram read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("telegram:read");
    expect(ZERO_CAPABILITIES).toContain("telegram:write");
  });

  it("should include teams write capability", () => {
    expect(ZERO_CAPABILITIES).toContain("teams:write");
  });

  it("should include phone read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("phone:read");
    expect(ZERO_CAPABILITIES).toContain("phone:write");
  });

  it("should include github read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("github:read");
    expect(ZERO_CAPABILITIES).toContain("github:write");
  });

  it("should include file read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("file:read");
    expect(ZERO_CAPABILITIES).toContain("file:write");
  });

  it("should include hosted-site read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("host:read");
    expect(ZERO_CAPABILITIES).toContain("host:write");
  });

  it("should include managed browser read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("browser:read");
    expect(ZERO_CAPABILITIES).toContain("browser:write");
  });

  it("should include managed maps read capability", () => {
    expect(ZERO_CAPABILITIES).toContain("maps:read");
  });

  it("should include managed weather read capability", () => {
    expect(ZERO_CAPABILITIES).toContain("weather:read");
  });

  it("should include managed scrape read capability", () => {
    expect(ZERO_CAPABILITIES).toContain("scrape:read");
  });

  it("should include managed web-search read capability", () => {
    expect(ZERO_CAPABILITIES).toContain("web-search:read");
    expect(ZERO_CAPABILITIES).toContain("people-search:read");
  });

  it("should include managed image recognition capability", () => {
    expect(ZERO_CAPABILITIES).toContain("image-recognition:write");
  });

  it("should include managed translation capability", () => {
    expect(ZERO_CAPABILITIES).toContain("translation:write");
  });

  it("should include managed finance read capability", () => {
    expect(ZERO_CAPABILITIES).toContain("finance:read");
  });

  it("should include managed SEO read capability", () => {
    expect(ZERO_CAPABILITIES).toContain("seo:read");
  });

  it("should include billing read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("billing:read");
    expect(ZERO_CAPABILITIES).toContain("billing:write");
  });

  it("should include connector read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("connector:read");
    expect(ZERO_CAPABILITIES).toContain("connector:write");
  });

  it("should include banking read capability", () => {
    expect(ZERO_CAPABILITIES).toContain("banking:read");
  });

  it("should include goal read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("goal:read");
    expect(ZERO_CAPABILITIES).toContain("goal:agent-result:write");
    expect(ZERO_CAPABILITIES).toContain("goal:user-control:write");
  });

  it("should include chat thread read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("chat-thread:read");
    expect(ZERO_CAPABILITIES).toContain("chat-thread:write");
  });

  it("should include chat event read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("chat-event:read");
    expect(ZERO_CAPABILITIES).toContain("chat-event:write");
  });
});

describe("ZERO_CAPABILITY_META", () => {
  it("should have metadata for every ZERO_CAPABILITY", () => {
    for (const cap of ZERO_CAPABILITIES) {
      expect(ZERO_CAPABILITY_META[cap]).toBeDefined();
      expect(ZERO_CAPABILITY_META[cap].group).toBeTruthy();
      expect(ZERO_CAPABILITY_META[cap].label).toBeTruthy();
    }
  });
});
