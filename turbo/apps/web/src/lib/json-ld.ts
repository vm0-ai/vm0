const JSON_LD_SCRIPT_ESCAPE_PATTERN = /[<>&\u2028\u2029]/gu;

function escapeJsonLdScriptCharacter(character: string): string {
  switch (character) {
    case "<":
      return "\\u003c";
    case ">":
      return "\\u003e";
    case "&":
      return "\\u0026";
    case "\u2028":
      return "\\u2028";
    case "\u2029":
      return "\\u2029";
    default:
      return character;
  }
}

export function serializeJsonLd(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("JSON-LD payload must be JSON-serializable");
  }
  return json.replace(
    JSON_LD_SCRIPT_ESCAPE_PATTERN,
    escapeJsonLdScriptCharacter,
  );
}
