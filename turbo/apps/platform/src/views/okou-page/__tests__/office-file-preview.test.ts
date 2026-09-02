import { describe, expect, it } from "vitest";
import {
  isOfficeFilePreview,
  officeFilePreviewKind,
} from "../office-file-preview.ts";

describe("officeFilePreviewKind", () => {
  it.each(["doc", "docm", "docx", "dot", "dotm", "dotx", "odt"])(
    "recognizes .%s documents",
    (extension) => {
      expect(officeFilePreviewKind(`brief.${extension}`)).toBe("document");
    },
  );

  it.each(["ods", "xls", "xlsb", "xlm", "xlsm", "xlsx"])(
    "recognizes .%s spreadsheets",
    (extension) => {
      expect(officeFilePreviewKind(`metrics.${extension}`)).toBe("spreadsheet");
    },
  );

  it.each([
    "odp",
    "pot",
    "potm",
    "potx",
    "pps",
    "ppsm",
    "ppsx",
    "ppt",
    "pptm",
    "pptx",
  ])("recognizes .%s presentations", (extension) => {
    expect(officeFilePreviewKind(`launch.${extension}`)).toBe("presentation");
  });

  it("matches extensions case-insensitively and ignores URL suffixes", () => {
    expect(officeFilePreviewKind("FORECAST.XLSX?download=1#sheet")).toBe(
      "spreadsheet",
    );
  });

  it.each(["xlt", "xltx", "xltm", "ppa", "ppam", "rtf", "one", "zip"])(
    "leaves unsupported .%s files on the generic fallback",
    (extension) => {
      expect(isOfficeFilePreview(`archive.${extension}`)).toBeFalsy();
    },
  );
});
