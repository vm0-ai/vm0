/** Read a charset parameter without matching text inside another quoted value. */
export function textEncoding(contentType: string): string | undefined {
  const parameters = contentType.matchAll(
    /;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/gu,
  );
  for (const parameter of parameters) {
    if (parameter[1]?.toLowerCase() === "charset") {
      return (parameter[2] ?? parameter[3] ?? "").replace(/\\(.)/gu, "$1");
    }
  }
  return undefined;
}

export function decodeText(bytes: Uint8Array, contentType: string): string {
  let encoding = textEncoding(contentType);
  // A Unicode BOM takes precedence, including for older uploaded files whose
  // stored media type has no charset parameter.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf8";
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
  }
  return new TextDecoder(encoding).decode(bytes);
}
