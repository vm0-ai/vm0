import { describe, expect, it } from "vitest";
import { buildWindowOptions } from "./desktop-recorder-window-options";
import type { DesktopRecorderSource } from "./desktop-recorder-types";

function source(
  overrides: Partial<DesktopRecorderSource> & { readonly id: string },
): DesktopRecorderSource {
  return {
    kind: "window",
    title: "Untitled",
    ...overrides,
  };
}

function preview(id: string) {
  return { id, previewDataUrl: `data:image/png;base64,${id}` };
}

describe("buildWindowOptions", () => {
  it("offers a window with the preview captured for it", () => {
    const options = buildWindowOptions(
      [
        source({
          id: "window:42",
          title: "Quarterly plan",
          appName: "Pages",
          bundleId: "com.apple.iWork.Pages",
        }),
      ],
      [preview("window:42")],
    );

    expect(options).toEqual([
      {
        id: "window:42",
        title: "Quarterly plan",
        appName: "Pages",
        previewDataUrl: "data:image/png;base64,window:42",
      },
    ]);
  });

  it("leaves out system chrome nobody records", () => {
    const options = buildWindowOptions(
      [
        source({
          id: "window:1",
          title: "Siri",
          appName: "控制中心",
          bundleId: "com.apple.controlcenter",
        }),
        source({
          id: "window:2",
          title: "Dock",
          appName: "程序坞",
          bundleId: "com.apple.dock",
        }),
        // The recorder's own overlays are on screen while the picker is open.
        source({
          id: "window:3",
          title: "Screen Recording",
          appName: "Okou",
          bundleId: "ai.okou.desktop",
        }),
        source({
          id: "window:4",
          title: "Inbox",
          appName: "Mail",
          bundleId: "com.apple.mail",
        }),
      ],
      [
        preview("window:1"),
        preview("window:2"),
        preview("window:3"),
        preview("window:4"),
      ],
    );

    expect(options.map((option) => option.title)).toEqual(["Inbox"]);
  });

  it("drops a window the helper could not preview", () => {
    const options = buildWindowOptions(
      [
        source({ id: "window:7", title: "Offscreen", appName: "Safari" }),
        source({ id: "window:8", title: "Visible", appName: "Safari" }),
      ],
      [preview("window:8")],
    );

    // A blank tile is worse than one fewer choice: the picker exists so the
    // window can be recognised by sight.
    expect(options.map((option) => option.title)).toEqual(["Visible"]);
  });

  it("ignores displays, which the picker does not offer", () => {
    const options = buildWindowOptions(
      [source({ id: "display:1", kind: "display", title: "Display 1" })],
      [preview("display:1")],
    );

    expect(options).toEqual([]);
  });

  it("groups windows by application", () => {
    const options = buildWindowOptions(
      [
        source({ id: "window:1", title: "Notes", appName: "Safari" }),
        source({ id: "window:2", title: "Inbox", appName: "Mail" }),
        source({ id: "window:3", title: "Archive", appName: "Mail" }),
      ],
      [preview("window:1"), preview("window:2"), preview("window:3")],
    );

    expect(
      options.map((option) => `${option.appName}/${option.title}`),
    ).toEqual(["Mail/Archive", "Mail/Inbox", "Safari/Notes"]);
  });
});
