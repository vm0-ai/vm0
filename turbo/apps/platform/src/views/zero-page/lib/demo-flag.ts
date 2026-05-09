/**
 * Shared preview / demo flag.
 *
 * `?demo=1` in the URL flips the flag on and writes it to sessionStorage so
 * it survives the Clerk auth redirect (which strips query params). Pages
 * that support a fixture-mode preview check this and substitute fake data.
 *
 * Toggle directly from devtools:
 *   sessionStorage.setItem("vm0:demo", "1"); location.reload();
 *   sessionStorage.removeItem("vm0:demo"); location.reload();
 *
 * `vm0:chatlist-demo` is the legacy key that only chat-list used. We still
 * honor it so anyone with it in their session keeps seeing demo mode after
 * the rename.
 */

const DEMO_KEY = "vm0:demo";
const LEGACY_CHAT_LIST_DEMO_KEY = "vm0:chatlist-demo";

export function readDemoFlag(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (window.location.search.includes("demo=1")) {
    window.sessionStorage.setItem(DEMO_KEY, "1");
  }
  return (
    window.sessionStorage.getItem(DEMO_KEY) === "1" ||
    window.sessionStorage.getItem(LEGACY_CHAT_LIST_DEMO_KEY) === "1"
  );
}
