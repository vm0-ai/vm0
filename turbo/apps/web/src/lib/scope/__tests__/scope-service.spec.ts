/**
 * Pure function tests for scope-service.
 *
 * Service method tests (createScope, getScopeBySlug, etc.) are tested
 * at the route level in apps/web/app/api/scope/__tests__/route.test.ts
 */
import { describe, it, expect } from "vitest";
import { validateScopeSlug } from "../scope-service";

describe("validateScopeSlug", () => {
  it("should accept valid slugs", () => {
    expect(() => validateScopeSlug("myslug")).not.toThrow();
    expect(() => validateScopeSlug("my-slug")).not.toThrow();
    expect(() => validateScopeSlug("my-long-slug-123")).not.toThrow();
    expect(() => validateScopeSlug("abc")).not.toThrow();
    expect(() => validateScopeSlug("a1b2c3")).not.toThrow();
  });

  it("should reject slugs that are too short", () => {
    expect(() => validateScopeSlug("ab")).toThrow();
    expect(() => validateScopeSlug("a")).toThrow();
    expect(() => validateScopeSlug("")).toThrow();
  });

  it("should reject slugs that are too long", () => {
    const longSlug = "a".repeat(65);
    expect(() => validateScopeSlug(longSlug)).toThrow();
  });

  it("should reject slugs with uppercase letters", () => {
    expect(() => validateScopeSlug("MySlug")).toThrow();
    expect(() => validateScopeSlug("MYSLUG")).toThrow();
  });

  it("should reject slugs with invalid characters", () => {
    expect(() => validateScopeSlug("my_slug")).toThrow();
    expect(() => validateScopeSlug("my.slug")).toThrow();
    expect(() => validateScopeSlug("my slug")).toThrow();
    expect(() => validateScopeSlug("my@slug")).toThrow();
  });

  it("should reject slugs starting with hyphen", () => {
    expect(() => validateScopeSlug("-myslug")).toThrow();
  });

  it("should reject slugs ending with hyphen", () => {
    expect(() => validateScopeSlug("myslug-")).toThrow();
  });

  it("should reject reserved slugs", () => {
    expect(() => validateScopeSlug("vm0")).toThrow();
    expect(() => validateScopeSlug("system")).toThrow();
    expect(() => validateScopeSlug("admin")).toThrow();
    expect(() => validateScopeSlug("api")).toThrow();
    expect(() => validateScopeSlug("app")).toThrow();
    expect(() => validateScopeSlug("www")).toThrow();
  });

  it("should reject slugs starting with vm0", () => {
    expect(() => validateScopeSlug("vm0test")).toThrow();
    expect(() => validateScopeSlug("vm0-custom")).toThrow();
  });
});
