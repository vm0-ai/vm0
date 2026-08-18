/// <reference types="micromark-extension-gfm-autolink-literal" />
// The reference above pulls in the `literalAutolink*` token types and the
// `_gfmAutolinkLiteralWalkedInto` field, both declared by the package this is
// vendored from. The tokens deliberately keep their upstream names so that
// `mdast-util-gfm-autolink-literal`, which `remark-gfm` already installs, turns
// them into link nodes.

import {
  asciiAlpha,
  asciiControl,
  markdownLineEndingOrSpace,
  unicodePunctuation,
  unicodeWhitespace,
} from "micromark-util-character";
import { codes } from "micromark-util-symbol";
import type {
  Code,
  Construct,
  ConstructRecord,
  Effects,
  Event,
  Extension,
  State,
  TokenizeContext,
} from "micromark-util-types";
import type { Processor } from "unified";

/**
 * GFM autolink literals that stop at full-width punctuation.
 *
 * `micromark-extension-gfm-autolink-literal` scans a bare URL up to the next
 * ASCII space and then trims only ASCII trailing punctuation (`?!.,:*_~`).
 * Chinese writes `。（）` straight against the link and puts no space anywhere
 * near it, so the scanner swallows the rest of the sentence:
 * `**https://example.com/a**。做` links `https://example.com/a**。做`, which is
 * a dead href, and it eats the closing `**` so the opening one renders as
 * literal text.
 *
 * This is the `www`/`http(s)` half of that extension, vendored from 2.1.0
 * (MIT, © Titus Wormer) with two deviations, both marked `CJK deviation` below:
 * non-ASCII punctuation ends a path, and it counts as an end while trimming a
 * trail. Email literals need no change — they already stop at the first
 * character that is not atext — so `remark-gfm`'s own constructs keep handling
 * those.
 *
 * The trade-off is deliberate: a full-width bracket that really is part of a
 * URL (`https://zh.wikipedia.org/wiki/中文（消歧义）`) now links only up to
 * `中文`. Prose that puts a bracket after a link is far more common in Chinese
 * than a URL that contains an unencoded one.
 */
function gfmAutolinkLiteralCjk(): Extension {
  return { text };
}

/**
 * Install the constructs above.
 *
 * Must be used *after* `remarkGfm`: `combineExtensions` prepends each
 * extension's constructs, so the one registered last is tried first and these
 * shadow the upstream `www`/`http(s)` pair. Both accept exactly the same
 * inputs, they only disagree on where the link ends, so the shadowed pair never
 * runs on a link this one rejects.
 */
export function remarkGfmAutolinkLiteralCjk(this: Processor): undefined {
  const data = this.data();
  const extensions = data.micromarkExtensions ?? [];
  data.micromarkExtensions = extensions;
  extensions.push(gfmAutolinkLiteralCjk());
}

/**
 * A punctuation character outside ASCII: `。`, `（`, `」`, `…`, `、` and the
 * rest of the full-width set. `unicodePunctuation` is micromark's own
 * `\p{P}|\p{S}` test, so this classifies characters the way the parser does
 * everywhere else.
 */
function nonAsciiPunctuation(code: Code): boolean {
  return code !== codes.eof && code > codes.del && unicodePunctuation(code);
}

const wwwPrefix: Readonly<Construct> = {
  tokenize: tokenizeWwwPrefix,
  partial: true,
};
const domain: Readonly<Construct> = { tokenize: tokenizeDomain, partial: true };
const path: Readonly<Construct> = { tokenize: tokenizePath, partial: true };
const trail: Readonly<Construct> = { tokenize: tokenizeTrail, partial: true };

const wwwAutolink: Readonly<Construct> = {
  name: "wwwAutolink",
  tokenize: tokenizeWwwAutolink,
  previous: previousWww,
};

const protocolAutolink: Readonly<Construct> = {
  name: "protocolAutolink",
  tokenize: tokenizeProtocolAutolink,
  previous: previousProtocol,
};

const text: Readonly<ConstructRecord> = {
  [codes.uppercaseH]: protocolAutolink,
  [codes.lowercaseH]: protocolAutolink,
  [codes.uppercaseW]: wwwAutolink,
  [codes.lowercaseW]: wwwAutolink,
};

/**
 * `www` autolink literal.
 *
 * ```markdown
 * > | a www.example.org b
 *       ^^^^^^^^^^^^^^^
 * ```
 */
function tokenizeWwwAutolink(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
): State {
  const self = this;

  return wwwStart;

  function wwwStart(code: Code): State | undefined {
    if (
      (code !== codes.uppercaseW && code !== codes.lowercaseW) ||
      !previousWww(self.previous) ||
      previousUnbalanced(self.events)
    ) {
      return nok(code);
    }

    effects.enter("literalAutolink");
    effects.enter("literalAutolinkWww");
    // Note: we *check*, so we can discard the `www.` we parsed.
    // If it worked, we consider it as a part of the domain.
    return effects.check(
      wwwPrefix,
      effects.attempt(domain, effects.attempt(path, wwwAfter), nok),
      nok,
    )(code);
  }

  function wwwAfter(code: Code): State | undefined {
    effects.exit("literalAutolinkWww");
    effects.exit("literalAutolink");
    return ok(code);
  }
}

/**
 * Protocol autolink literal.
 *
 * ```markdown
 * > | a https://example.org b
 *       ^^^^^^^^^^^^^^^^^^^
 * ```
 */
function tokenizeProtocolAutolink(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
): State {
  const self = this;
  let buffer = "";
  let seen = false;

  return protocolStart;

  function protocolStart(code: Code): State | undefined {
    if (
      (code === codes.uppercaseH || code === codes.lowercaseH) &&
      previousProtocol(self.previous) &&
      !previousUnbalanced(self.events)
    ) {
      effects.enter("literalAutolink");
      effects.enter("literalAutolinkHttp");
      buffer += String.fromCodePoint(code);
      effects.consume(code);
      return protocolPrefixInside;
    }

    return nok(code);
  }

  function protocolPrefixInside(code: Code): State | undefined {
    // `5` is the size of `https`. The `eof` test only narrows `code` to a
    // number for `fromCodePoint`; `asciiAlpha` already rejects `eof`.
    if (code !== codes.eof && asciiAlpha(code) && buffer.length < 5) {
      buffer += String.fromCodePoint(code);
      effects.consume(code);
      return protocolPrefixInside;
    }

    if (code === codes.colon) {
      const protocol = buffer.toLowerCase();

      if (protocol === "http" || protocol === "https") {
        effects.consume(code);
        return protocolSlashesInside;
      }
    }

    return nok(code);
  }

  function protocolSlashesInside(code: Code): State | undefined {
    if (code === codes.slash) {
      effects.consume(code);

      if (seen) {
        return afterProtocol;
      }

      seen = true;
      return protocolSlashesInside;
    }

    return nok(code);
  }

  function afterProtocol(code: Code): State | undefined {
    return code === codes.eof ||
      asciiControl(code) ||
      markdownLineEndingOrSpace(code) ||
      unicodeWhitespace(code) ||
      unicodePunctuation(code)
      ? nok(code)
      : effects.attempt(
          domain,
          effects.attempt(path, protocolAfter),
          nok,
        )(code);
  }

  function protocolAfter(code: Code): State | undefined {
    effects.exit("literalAutolinkHttp");
    effects.exit("literalAutolink");
    return ok(code);
  }
}

/**
 * `www` prefix.
 *
 * ```markdown
 * > | a www.example.org b
 *       ^^^^
 * ```
 */
function tokenizeWwwPrefix(effects: Effects, ok: State, nok: State): State {
  let size = 0;

  return wwwPrefixInside;

  function wwwPrefixInside(code: Code): State | undefined {
    if ((code === codes.uppercaseW || code === codes.lowercaseW) && size < 3) {
      size++;
      effects.consume(code);
      return wwwPrefixInside;
    }

    if (code === codes.dot && size === 3) {
      effects.consume(code);
      return wwwPrefixAfter;
    }

    return nok(code);
  }

  function wwwPrefixAfter(code: Code): State | undefined {
    // If there is *anything*, we can link.
    return code === codes.eof ? nok(code) : ok(code);
  }
}

/**
 * Domain.
 *
 * ```markdown
 * > | a https://example.org b
 *               ^^^^^^^^^^^
 * ```
 */
function tokenizeDomain(effects: Effects, ok: State, nok: State): State {
  let underscoreInLastSegment: boolean | undefined;
  let underscoreInLastLastSegment: boolean | undefined;
  let seen: boolean | undefined;

  return domainInside;

  function domainInside(code: Code): State | undefined {
    // Check whether this marker, which is a trailing punctuation marker,
    // optionally followed by more trailing markers, and then followed by an
    // end.
    if (code === codes.dot || code === codes.underscore) {
      return effects.check(trail, domainAfter, domainAtPunctuation)(code);
    }

    // GH documents that only alphanumerics (other than `-`, `.`, and `_`) can
    // occur, which sounds like ASCII only, but they also support `www.點看.com`,
    // so that's Unicode. Markdown already has productions for Unicode
    // punctuation and whitespace, so use those.
    if (
      code === codes.eof ||
      markdownLineEndingOrSpace(code) ||
      unicodeWhitespace(code) ||
      (code !== codes.dash && unicodePunctuation(code))
    ) {
      return domainAfter(code);
    }

    seen = true;
    effects.consume(code);
    return domainInside;
  }

  function domainAtPunctuation(code: Code): State | undefined {
    // There is an underscore in the last segment of the domain.
    if (code === codes.underscore) {
      underscoreInLastSegment = true;
    }
    // Otherwise, it's a `.`: save the last segment underscore in the
    // penultimate segment slot.
    else {
      underscoreInLastLastSegment = underscoreInLastSegment;
      underscoreInLastSegment = undefined;
    }

    effects.consume(code);
    return domainInside;
  }

  function domainAfter(code: Code): State | undefined {
    if (
      underscoreInLastLastSegment === true ||
      underscoreInLastSegment === true ||
      seen !== true
    ) {
      return nok(code);
    }

    return ok(code);
  }
}

/** Punctuation in a path that may turn out to be trailing rather than linked. */
function pathTrailingMarker(code: Code): boolean {
  return (
    code === codes.exclamationMark ||
    code === codes.quotationMark ||
    code === codes.ampersand ||
    code === codes.apostrophe ||
    code === codes.rightParenthesis ||
    code === codes.asterisk ||
    code === codes.comma ||
    code === codes.dot ||
    code === codes.colon ||
    code === codes.semicolon ||
    code === codes.lessThan ||
    code === codes.questionMark ||
    code === codes.rightSquareBracket ||
    code === codes.underscore ||
    code === codes.tilde
  );
}

/**
 * Path.
 *
 * ```markdown
 * > | a https://example.org/stuff b
 *                          ^^^^^^
 * ```
 */
function tokenizePath(effects: Effects, ok: State): State {
  let sizeOpen = 0;
  let sizeClose = 0;

  return pathInside;

  function pathInside(code: Code): State | undefined {
    if (code === codes.leftParenthesis) {
      sizeOpen++;
      effects.consume(code);
      return pathInside;
    }

    // If this is a paren, and there are less closings than openings, we don't
    // check for a trail.
    if (code === codes.rightParenthesis && sizeClose < sizeOpen) {
      return pathAtPunctuation(code);
    }

    // Check whether this trailing punctuation marker is optionally followed by
    // more trailing markers, and then followed by an end.
    if (pathTrailingMarker(code)) {
      return effects.check(trail, ok, pathAtPunctuation)(code);
    }

    if (
      code === codes.eof ||
      markdownLineEndingOrSpace(code) ||
      unicodeWhitespace(code) ||
      // CJK deviation: a full-width character ends the URL the way a space
      // does, so `…/a（draft）后续` links `…/a` instead of the whole sentence.
      nonAsciiPunctuation(code)
    ) {
      return ok(code);
    }

    effects.consume(code);
    return pathInside;
  }

  function pathAtPunctuation(code: Code): State | undefined {
    // Count closing parens.
    if (code === codes.rightParenthesis) {
      sizeClose++;
    }

    effects.consume(code);
    return pathInside;
  }
}

/**
 * Trail.
 *
 * This calls `ok` if this *is* the trail, followed by an end, which means the
 * entire trail is not part of the link. It calls `nok` if this *is* part of
 * the link.
 *
 * ```markdown
 * > | https://example.com").
 *                        ^^^
 * ```
 */
function tokenizeTrail(effects: Effects, ok: State, nok: State): State {
  return trailStart;

  function trailStart(code: Code): State | undefined {
    // Regular trailing punctuation.
    if (
      code === codes.exclamationMark ||
      code === codes.quotationMark ||
      code === codes.apostrophe ||
      code === codes.rightParenthesis ||
      code === codes.asterisk ||
      code === codes.comma ||
      code === codes.dot ||
      code === codes.colon ||
      code === codes.semicolon ||
      code === codes.questionMark ||
      code === codes.underscore ||
      code === codes.tilde
    ) {
      effects.consume(code);
      return trailStart;
    }

    // `&` followed by one or more alphabeticals and then a `;` is, as a whole,
    // considered trailing punctuation. In all other cases it continues the URL.
    if (code === codes.ampersand) {
      effects.consume(code);
      return trailCharacterReferenceStart;
    }

    // Needed because literals are allowed after `[`; check that it is not
    // followed by `(` or `[`.
    if (code === codes.rightSquareBracket) {
      effects.consume(code);
      return trailBracketAfter;
    }

    if (
      // `<` is an end.
      code === codes.lessThan ||
      // So is whitespace.
      code === codes.eof ||
      markdownLineEndingOrSpace(code) ||
      unicodeWhitespace(code) ||
      // CJK deviation: so is full-width punctuation, which is what makes the
      // `**` in `**https://example.com/a**。` a trail rather than part of the
      // link — Chinese leaves no space for the upstream rule to find.
      nonAsciiPunctuation(code)
    ) {
      return ok(code);
    }

    return nok(code);
  }

  function trailBracketAfter(code: Code): State | undefined {
    // Whitespace or something that could start a resource or reference is the
    // end. Switch back to the trail otherwise.
    if (
      code === codes.eof ||
      code === codes.leftParenthesis ||
      code === codes.leftSquareBracket ||
      markdownLineEndingOrSpace(code) ||
      unicodeWhitespace(code)
    ) {
      return ok(code);
    }

    return trailStart(code);
  }

  function trailCharacterReferenceStart(code: Code): State | undefined {
    // When non-alpha, it's not a trail.
    return asciiAlpha(code) ? trailCharacterReferenceInside(code) : nok(code);
  }

  function trailCharacterReferenceInside(code: Code): State | undefined {
    // Switch back to the trail if this is well-formed.
    if (code === codes.semicolon) {
      effects.consume(code);
      return trailStart;
    }

    if (asciiAlpha(code)) {
      effects.consume(code);
      return trailCharacterReferenceInside;
    }

    // It's not a trail.
    return nok(code);
  }
}

/**
 * Whether a `www` literal may start here. Hoisted declarations, because the
 * constructs above capture them while the module body still evaluates.
 */
function previousWww(code: Code): boolean {
  return (
    code === codes.eof ||
    code === codes.leftParenthesis ||
    code === codes.asterisk ||
    code === codes.underscore ||
    code === codes.leftSquareBracket ||
    code === codes.rightSquareBracket ||
    code === codes.tilde ||
    markdownLineEndingOrSpace(code)
  );
}

/** Whether an `http(s)` literal may start here. */
function previousProtocol(code: Code): boolean {
  return !asciiAlpha(code);
}

/**
 * Whether an unclosed `[` sits before this position, which means the literal is
 * inside a label and must not link.
 */
function previousUnbalanced(events: readonly Event[]): boolean {
  let index = events.length;
  let result = false;

  while (index--) {
    const token = events[index][1];

    if (
      (token.type === "labelLink" || token.type === "labelImage") &&
      token._balanced !== true
    ) {
      result = true;
      break;
    }

    // If this token was seen before, and it was marked as not having any
    // unbalanced bracket before it, we can exit.
    if (token._gfmAutolinkLiteralWalkedInto === true) {
      result = false;
      break;
    }
  }

  if (events.length > 0 && !result) {
    // Mark the last token as "walked into" without finding anything.
    events[events.length - 1][1]._gfmAutolinkLiteralWalkedInto = true;
  }

  return result;
}
