import { describe, expect, it, afterEach } from "vitest";

import { queryAllByRoleFast } from "./page-helper.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("queryAllByRoleFast role disambiguation", () => {
  it('treats <th scope="row"> as rowheader, not columnheader', () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>Col A</th><th>Col B</th></tr></thead>
        <tbody>
          <tr><th scope="row">Row 1</th><td>v1</td></tr>
          <tr><th scope="row">Row 2</th><td>v2</td></tr>
        </tbody>
      </table>
    `;

    const columnheaders = queryAllByRoleFast("columnheader").map((el) => {
      return el.textContent?.trim();
    });
    expect(columnheaders).toStrictEqual(["Col A", "Col B"]);

    const rowheaders = queryAllByRoleFast("rowheader").map((el) => {
      return el.textContent?.trim();
    });
    expect(rowheaders).toStrictEqual(["Row 1", "Row 2"]);
  });

  it("treats explicit role override the same as a native tag", () => {
    document.body.innerHTML = `
      <div>
        <button>native</button>
        <div role="button">aria</div>
        <span role="link">link via role</span>
        <a href="/foo">native link</a>
        <a>no href, no role</a>
      </div>
    `;

    expect(
      queryAllByRoleFast("button").map((el) => {
        return el.textContent;
      }),
    ).toStrictEqual(["native", "aria"]);
    expect(
      queryAllByRoleFast("link").map((el) => {
        return el.textContent;
      }),
    ).toStrictEqual(["link via role", "native link"]);
  });

  it("excludes descendants of aria-hidden, hidden, or inert subtrees", () => {
    document.body.innerHTML = `
      <button>visible</button>
      <div aria-hidden="true"><button>hidden via aria</button></div>
      <div inert><button>hidden via inert</button></div>
      <div hidden><button>hidden via hidden</button></div>
    `;

    expect(
      queryAllByRoleFast("button").map((el) => {
        return el.textContent;
      }),
    ).toStrictEqual(["visible"]);
  });

  it("scopes results to the given container", () => {
    document.body.innerHTML = `
      <button>outside</button>
      <div id="scope"><button>inside-a</button><button>inside-b</button></div>
    `;
    const scope = document.getElementById("scope")!;

    expect(
      queryAllByRoleFast("button", scope).map((el) => {
        return el.textContent;
      }),
    ).toStrictEqual(["inside-a", "inside-b"]);
  });
});
