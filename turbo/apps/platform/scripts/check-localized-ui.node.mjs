import assert from "node:assert/strict";
import test from "node:test";

import { checkSource } from "./check-localized-ui.mjs";

function violationValues(sourceText, relativePath = "src/example.tsx") {
  return checkSource(relativePath, sourceText).map((violation) => {
    return violation.value;
  });
}

await test("rejects direct user-visible literals", () => {
  const values = violationValues(`
    const card = { title: "Hardcoded title" };
    function View() {
      return <button aria-label="Save item">Delete item</button>;
    }
    toast.error("Save failed");
    set(updateDocumentTitle$, "Thread details");
  `);

  assert.deepEqual(
    new Set(values),
    new Set([
      "Hardcoded title",
      "Save item",
      "Delete item",
      "Save failed",
      "Thread details",
    ]),
  );
});

await test("rejects indirect display maps and formatter output", () => {
  const values = violationValues(`
    const TOOL_DISPLAY_NAMES = {
      fetch: "Web Fetch",
    };
    function formatGenericCodexItem() {
      const lines = [];
      lines.push("Status: ready");
      return ["Files changed", ...lines].join("\\n");
    }
    function messageDocumentToDisplayText() {
      let text = "";
      text += "Attached file";
      return text;
    }
    function formatMessageHtml() {
      const attachments = "<div>Attachments:</div>";
      return attachments;
    }
    function stringifyArrayJsonValue() {
      const items = [];
      items.push(quoteJsonString("... 5 more items"));
      return items.join(",");
    }
  `);

  assert.deepEqual(
    new Set(values),
    new Set([
      "Web Fetch",
      "Status: ready",
      "Files changed",
      "Attached file",
      "Attachments:",
      "... 5 more items",
    ]),
  );
});

await test("accepts project translation bindings", () => {
  const values = violationValues(`
    import { useTranslation as useAppTranslation } from "react-i18next";
    import { i18n as appI18n } from "../i18n/index.ts";

    function View() {
      const { t: translate } = useAppTranslation();
      return (
        <div title={translate(($) => $.card.title)}>
          {appI18n.t(($) => $.card.message)}
        </div>
      );
    }
  `);

  assert.deepEqual(values, []);
});

await test("rejects unrelated functions and methods named t", () => {
  const values = violationValues(`
    const t = (value: string) => value;
    const tracker = { t: (value: string) => value };
    function View() {
      return (
        <>
          <span>{t("Local hardcode")}</span>
          <span>{tracker.t("Method hardcode")}</span>
        </>
      );
    }
  `);

  assert.deepEqual(
    new Set(values),
    new Set(["Local hardcode", "Method hardcode"]),
  );
});

await test("rejects shadowed translation bindings", () => {
  const values = violationValues(`
    import { useTranslation } from "react-i18next";
    import { i18n as appI18n } from "../i18n/index.ts";

    function View() {
      const { t } = useTranslation();
      function Nested(t: (value: string) => string) {
        return <span>{t("Shadowed hook hardcode")}</span>;
      }
      function Other() {
        const appI18n = { t: (value: string) => value };
        return <span>{appI18n.t("Shadowed i18n hardcode")}</span>;
      }
      return (
        <>
          <span>{t(($) => $.card.title)}</span>
          <Nested t={(value) => value} />
          <Other />
        </>
      );
    }
  `);

  assert.deepEqual(
    new Set(values),
    new Set(["Shadowed hook hardcode", "Shadowed i18n hardcode"]),
  );
});
