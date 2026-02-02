import { describe, it, expect } from "vitest";
import { createVmId, vmIdValue } from "../vm-id.js";

describe("createVmId", () => {
  it("should pad short inputs with leading zeros", () => {
    expect(vmIdValue(createVmId("abc"))).toBe("00000abc");
    expect(vmIdValue(createVmId("vm1"))).toBe("00000vm1");
    expect(vmIdValue(createVmId("a"))).toBe("0000000a");
  });

  it("should truncate long inputs to 8 characters", () => {
    expect(vmIdValue(createVmId("abcdefghij"))).toBe("abcdefgh");
    expect(vmIdValue(createVmId("12345678901234"))).toBe("12345678");
  });

  it("should keep 8-character inputs unchanged", () => {
    expect(vmIdValue(createVmId("12345678"))).toBe("12345678");
    expect(vmIdValue(createVmId("abcdefgh"))).toBe("abcdefgh");
  });

  it("should handle UUID format (extract first 8 chars)", () => {
    expect(vmIdValue(createVmId("550e8400-e29b-41d4-a716-446655440000"))).toBe(
      "550e8400",
    );
  });

  it("should handle empty string", () => {
    expect(vmIdValue(createVmId(""))).toBe("00000000");
  });
});

describe("vmIdValue", () => {
  it("should return the string value of a VmId", () => {
    const vmId = createVmId("test1234");
    expect(vmIdValue(vmId)).toBe("test1234");
  });
});
