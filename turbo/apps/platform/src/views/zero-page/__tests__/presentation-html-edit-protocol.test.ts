import { describe, expect, it } from "vitest";

import { parsePresentationEditDraft } from "../presentation-html-edit-protocol.ts";

describe("presentation HTML edit protocol", () => {
  it("selects a unique inner slide canvas inside legacy viewport wrappers", () => {
    const draft = parsePresentationEditDraft(`<!doctype html>
<html>
  <body>
    <section class="slide" data-slide-id="outer-slide">
      <div class="stage">
        <h1 data-vm0-editable="text" data-vm0-edit-id="title">Quarterly results</h1>
      </div>
    </section>
  </body>
</html>`);

    expect(draft.slides).toStrictEqual([
      {
        id: "outer-slide",
        notes: "",
        title: "Quarterly results",
      },
    ]);
    expect(draft.blocks).toStrictEqual([
      {
        editId: "title",
        slideId: "outer-slide",
        tagName: "h1",
        text: "Quarterly results",
      },
    ]);
    expect(draft.html).toContain(
      '<div class="stage" data-slide-id="outer-slide">',
    );
  });

  it("falls back to the wrapper when there is no unique inner slide canvas", () => {
    const draft = parsePresentationEditDraft(`<!doctype html>
<html>
  <body>
    <section class="slide" data-slide-id="outer-slide">
      <div class="stage">First candidate</div>
      <div class="stage">Second candidate</div>
    </section>
  </body>
</html>`);

    expect(draft.slides[0]?.id).toBe("outer-slide");
  });
});
