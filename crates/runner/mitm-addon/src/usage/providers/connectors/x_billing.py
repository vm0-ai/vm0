"""X billing bucket classification.

Maps firewall permission + request method/path to one of X's official
per-API pricing buckets (see https://docs.x.com/x-api/getting-started/pricing).
The bucket name is written to ``usage_event.category`` and used by the
server-side billing processor to look up ``unit_price`` in
``usage_pricing``.

Body-dependent refinement is applied on top via
:func:`refine_bucket_with_body` — currently used to drop
``content.create_with_url`` to ``content.create`` when the POST /2/tweets
body contains no URL.

Design:

- ``_PERMISSION_TO_BUCKET`` gives each firewall scope a default bucket.
  The default is chosen to match the MAJORITY of paths in that scope
  so the category name stays semantically meaningful (a tweet-read
  request lands in ``posts.read``, not ``user.read``).

- ``_PATH_OVERRIDES`` holds per-path refinements when a specific path
  within a scope belongs to a different X bucket than the scope default.
  Overrides may raise OR lower the price — the goal is accuracy, not
  one-sided safety.

  **Important**: X's public pricing page lists bucket names and prices
  but does NOT publish an endpoint → bucket mapping.  The overrides
  here are semantic inferences from the bucket names (e.g. DELETE of
  your own content → ``content.manage``).  A handful of overrides
  lower price by 10–40× based on name semantics alone.  Validate
  against Developer Console billing data or empirical live calls
  before relying on the numbers; drift from X's actual classification
  will cause under- or over-charging until an override is corrected.

- ``_INCLUDES_TO_BUCKET`` maps X v2 ``includes.<key>`` resource types
  to buckets.  Unknown keys return ``None`` and the caller emits a
  synthetic ``includes.<key>`` category; the billing processor applies
  a server-side fallback price for these.

- Scopes that are not billable (e.g. the ``"app-only"`` group for
  BearerToken-only endpoints) are intentionally absent; ``classify_bucket``
  returns ``None`` and the caller skips emitting a ``usage_event`` row.
  That matches current behaviour where ``BILLABLE_CONNECTORS`` only
  covers user-authenticated X calls.

New X endpoints appearing in a scope but not in overrides will be
billed at the scope default.  If X's own pricing for that new endpoint
is higher than the default bucket, we'd under-charge until an override
is added — monitor the firewall generator output and the X pricing
sheet for drift.
"""

import json
import re

from matching import CompiledPathPattern, compile_path_pattern, match_compiled_path

from .x_tlds import IANA_TLDS

# Permission → default bucket.  The default matches the majority of
# paths in the scope; outliers go in `_PATH_OVERRIDES`.  Prices are
# defined in turbo/apps/web/scripts/dev-seed.ts.
_PERMISSION_TO_BUCKET: dict[str, str] = {
    # — Writes with an unambiguous single bucket —
    "tweet.moderate.write": "content.manage",
    "bookmark.write": "bookmark",
    "dm.write": "dm_interaction.create",
    # — Writes that span multiple X buckets — default to the more
    # expensive variant so an unmapped path never under-charges —
    # tweet.write: Content: Create vs Content: Create (with URL).
    # Distinguished by request body inspection in refine_bucket_with_body.
    # DELETE /2/tweets/{id} and DELETE /2/notes/{id} split off to
    # content.manage; retweet create/undo split off to
    # user_interaction.create / interaction.delete — see overrides.
    "tweet.write": "content.create_with_url",
    # media.write: public upload paths stay on Content: Create (with URL);
    # GETs, metadata/subtitles, and chat (DM) media uploads split off
    # via overrides.
    "media.write": "content.create_with_url",
    # User-interaction writes: POST creates are User Interaction: Create;
    # DELETE undoes are Interaction: Delete (Mute: Delete for mute).
    # Default = POST bucket; DELETE paths go in override.
    "like.write": "user_interaction.create",
    "follows.write": "user_interaction.create",
    "mute.write": "user_interaction.create",
    # list.write: POST /2/lists is List: Create; everything else is
    # List: Manage — see override.
    "list.write": "list.create",
    # — Reads —
    "bookmark.read": "posts.read",
    "dm.read": "dm_event.read",
    "follows.read": "following_followers.read",
    "like.read": "posts.read",
    "timeline.read": "posts.read",
    "space.read": "space.read",
    "list.read": "list.read",
    # Scopes whose response is a list of users
    "block.read": "user.read",
    "mute.read": "user.read",
    # tweet.read: majority of paths return tweets (Posts: Read).
    # Outlier /2/tweets/{id}/retweeted_by returns users — see override.
    "tweet.read": "posts.read",
    # users.read: majority return user records (User: Read).
    # Paths that return tweets (/mentions, /timelines, /tweets) and
    # /communities/search go to cheaper buckets via override.
    "users.read": "user.read",
}

# Per-path refinements when a specific path within a scope belongs to a
# different X bucket than the scope default.  First-match wins.
_PATH_OVERRIDES: list[tuple[str, str, str, str]] = [
    # (scope, method, path pattern, bucket)
    #
    # — reads —
    # tweet.read: retweeted_by returns users, priced as User: Read.
    ("tweet.read", "GET", "/2/tweets/{id}/retweeted_by", "user.read"),
    # tweet.read: analytics / media / note paths share the posts.read
    # price but belong to semantically distinct X buckets.
    ("tweet.read", "GET", "/2/insights/28hr", "analytics.read"),
    ("tweet.read", "GET", "/2/insights/historical", "analytics.read"),
    ("tweet.read", "GET", "/2/media/analytics", "analytics.read"),
    ("tweet.read", "GET", "/2/tweets/analytics", "analytics.read"),
    ("tweet.read", "GET", "/2/media", "media.read"),
    ("tweet.read", "GET", "/2/media/{media_key}", "media.read"),
    ("tweet.read", "GET", "/2/notes/search/notes_written", "note.read"),
    ("tweet.read", "GET", "/2/notes/search/posts_eligible_for_notes", "note.read"),
    # users.read: paths returning tweets are Posts: Read.
    ("users.read", "GET", "/2/users/{id}/mentions", "posts.read"),
    ("users.read", "GET", "/2/users/{id}/timelines/reverse_chronological", "posts.read"),
    ("users.read", "GET", "/2/users/{id}/tweets", "posts.read"),
    # users.read: community search is Community: Read.
    ("users.read", "GET", "/2/communities/search", "community.read"),
    #
    # — writes: undo actions go to Interaction: Delete —
    ("like.write", "DELETE", "/2/users/{id}/likes/{tweet_id}", "interaction.delete"),
    (
        "follows.write",
        "DELETE",
        "/2/users/{source_user_id}/following/{target_user_id}",
        "interaction.delete",
    ),
    #
    # — tweet.write: DELETE of your own content is Content: Manage;
    # retweeting is a User Interaction (create/delete).  POST /2/notes
    # stays on the default because a note can carry URLs; evaluating
    # a community note is a user interaction, not content creation.
    # (X does not publish endpoint-to-bucket mapping — these are
    # semantic inferences from the bucket names in the pricing page.)
    ("tweet.write", "DELETE", "/2/tweets/{id}", "content.manage"),
    ("tweet.write", "DELETE", "/2/notes/{id}", "content.manage"),
    ("tweet.write", "POST", "/2/users/{id}/retweets", "user_interaction.create"),
    (
        "tweet.write",
        "DELETE",
        "/2/users/{id}/retweets/{source_tweet_id}",
        "interaction.delete",
    ),
    ("tweet.write", "POST", "/2/evaluate_note", "user_interaction.create"),
    #
    # — dm.write: deleting a DM you sent is managing your own content —
    ("dm.write", "DELETE", "/2/dm_events/{event_id}", "content.manage"),
    #
    # — mute undo is its own Mute: Delete bucket, cheaper than
    # Interaction: Delete —
    (
        "mute.write",
        "DELETE",
        "/2/users/{source_user_id}/muting/{target_user_id}",
        "mute.delete",
    ),
    #
    # — list.write: default is List: Create for POST /2/lists; every
    # other path in the scope is List: Manage —
    ("list.write", "PUT", "/2/lists/{id}", "list.manage"),
    ("list.write", "DELETE", "/2/lists/{id}", "list.manage"),
    ("list.write", "POST", "/2/lists/{id}/members", "list.manage"),
    ("list.write", "DELETE", "/2/lists/{id}/members/{user_id}", "list.manage"),
    ("list.write", "POST", "/2/users/{id}/followed_lists", "list.manage"),
    ("list.write", "DELETE", "/2/users/{id}/followed_lists/{list_id}", "list.manage"),
    ("list.write", "POST", "/2/users/{id}/pinned_lists", "list.manage"),
    ("list.write", "DELETE", "/2/users/{id}/pinned_lists/{list_id}", "list.manage"),
    #
    # — bookmark removal is still Bookmark, not Interaction: Delete.
    # (Default already covers POST; DELETE explicitly kept in the same
    # bucket to document that we checked.) —
    ("bookmark.write", "DELETE", "/2/users/{id}/bookmarks/{tweet_id}", "bookmark"),
    #
    # — media.write: default covers public upload paths; GETs, metadata,
    # subtitles, and chat (DM) media uploads split off to cheaper
    # buckets.  Chat media routes are in DM context, so we infer
    # DM Interaction: Create (same inference confidence as the DM
    # write overrides above — not docs-confirmed). —
    ("media.write", "GET", "/2/media/upload", "media.read"),
    ("media.write", "GET", "/2/chat/media/{id}/{media_hash_key}", "media.read"),
    ("media.write", "POST", "/2/media/metadata", "media_metadata"),
    ("media.write", "POST", "/2/media/subtitles", "media_metadata"),
    ("media.write", "DELETE", "/2/media/subtitles", "media_metadata"),
    ("media.write", "POST", "/2/chat/media/upload/initialize", "dm_interaction.create"),
    ("media.write", "POST", "/2/chat/media/upload/{id}/append", "dm_interaction.create"),
    ("media.write", "POST", "/2/chat/media/upload/{id}/finalize", "dm_interaction.create"),
]


def _build_override_index(
    overrides: list[tuple[str, str, str, str]],
) -> dict[tuple[str, str], list[tuple[CompiledPathPattern, str]]]:
    """Group overrides by ``(scope, method)`` so :func:`classify_bucket`
    only walks patterns under the matching scope/method instead of the
    full list.  Insertion order is preserved inside each bucket, which
    keeps first-match-wins semantics from the source list.
    """
    index: dict[tuple[str, str], list[tuple[CompiledPathPattern, str]]] = {}
    for scope, method, pattern, bucket in overrides:
        compiled_pattern = compile_path_pattern(pattern)
        if compiled_pattern is None:
            raise ValueError(f"invalid X billing override path pattern: {scope} {method} {pattern}")
        index.setdefault((scope, method), []).append((compiled_pattern, bucket))
    return index


_OVERRIDE_INDEX = _build_override_index(_PATH_OVERRIDES)


def classify_bucket(permission: str, method: str, path: str) -> str | None:
    """Return the X billing bucket for a matched firewall request.

    ``permission`` is the firewall permission name set on
    ``flow.metadata["firewall_permission"]``.  ``method`` and ``path``
    come from ``flow.request``.

    Returns ``None`` for permissions that are not billable (e.g. the
    ``"app-only"`` scope).  The caller should skip emission in that
    case.
    """
    for pattern, bucket in _OVERRIDE_INDEX.get((permission, method.upper()), ()):
        if match_compiled_path(path, pattern) is not None:
            return bucket
    return _PERMISSION_TO_BUCKET.get(permission)


# X v2 ``includes.<key>`` resource types → X billing bucket.
# Irregular cases: includes key is plural while firewall permission is
# singular (``tweets`` → Posts: Read, ``spaces`` → Space: Read).
_INCLUDES_TO_BUCKET: dict[str, str] = {
    "users": "user.read",
    "tweets": "posts.read",
    "media": "media.read",
    "polls": "posts.read",
    "places": "posts.read",
    "topics": "posts.read",
    "spaces": "space.read",
}


def classify_includes_bucket(key: str) -> str | None:
    """Return the billing bucket for an ``includes.<key>`` resource
    type, or ``None`` if the key is not recognized.  Caller is
    responsible for substituting a safe over-charging fallback.
    """
    return _INCLUDES_TO_BUCKET.get(key)


# URL detector for tweet body refinement.  Billing needs a conservative
# "could X auto-link this?" boolean, not link indices.  Keep protocol
# matching case-insensitive and preserve twitter-text-style boundary
# guards so emails, mentions, hashtags and cashtags do not look like
# scheme-less URLs.
_URL_PRECEDING_CHARS = r"A-Za-z0-9@\uFF20$#\uFF03"
_URL_WITH_PROTOCOL_RE = re.compile(rf"(?<![{_URL_PRECEDING_CHARS}])https?://", re.IGNORECASE)
_URL_FOLLOWING_CHARS = r"A-Za-z0-9@+.-"
_DOMAIN_CODEPOINT = r"[^\W_]"
_DOMAIN_CANDIDATE_CHAR = rf"(?:{_DOMAIN_CODEPOINT}|-)"
_BARE_DOMAIN_CANDIDATE_RE = re.compile(
    rf"(?<![{_URL_PRECEDING_CHARS}._/-])"
    rf"({_DOMAIN_CANDIDATE_CHAR}+(?:\.{_DOMAIN_CANDIDATE_CHAR}+)+)"
    rf"(?=$|[^{_URL_FOLLOWING_CHARS}]|\.(?:$|[^A-Za-z0-9]))",
    re.IGNORECASE,
)
_DOMAIN_LABEL_RE = re.compile(r"^[a-z0-9-]{1,63}$")
_MIN_DOMAIN_LABELS = 2
_URL_TRAILING_PUNCTUATION = ".,:;!?"
_URL_WRAPPER_CHARS = " \t\r\n<>()[]{}\"'"


def _host_from_bare_domain_candidate(candidate: str) -> str | None:
    candidate = candidate.strip(_URL_WRAPPER_CHARS).rstrip(_URL_TRAILING_PUNCTUATION)
    if not candidate:
        return None

    host = candidate.split("/", maxsplit=1)[0]
    host = host.split("?", maxsplit=1)[0]
    host = host.split("#", maxsplit=1)[0]
    host = host.rstrip(_URL_TRAILING_PUNCTUATION)
    if not host:
        return None

    return host.rstrip(".")


def _idna_domain_labels(host: str) -> tuple[str, ...] | None:
    labels = host.split(".")
    if len(labels) < _MIN_DOMAIN_LABELS:
        return None

    normalized_labels = []
    for label in labels:
        if not label:
            return None
        try:
            normalized = label.encode("idna").decode("ascii").lower()
        except UnicodeError:
            return None
        if (
            _DOMAIN_LABEL_RE.fullmatch(normalized) is None
            or normalized.startswith("-")
            or normalized.endswith("-")
        ):
            return None
        normalized_labels.append(normalized)

    return tuple(normalized_labels)


def _bare_domain_candidate_likely_contains_url(candidate: str) -> bool:
    host = _host_from_bare_domain_candidate(candidate)
    if host is None:
        return False
    labels = _idna_domain_labels(host)
    return labels is not None and labels[-1] in IANA_TLDS


def _tweet_text_likely_contains_url(text: str) -> bool:
    if _URL_WITH_PROTOCOL_RE.search(text) is not None:
        return True
    if "." not in text:
        return False
    return any(
        _bare_domain_candidate_likely_contains_url(match.group(1))
        for match in _BARE_DOMAIN_CANDIDATE_RE.finditer(text)
    )


def refine_bucket_with_body(bucket: str, method: str, path: str, body: bytes | None) -> str:
    """Refine a bucket using the request body, when the body carries
    billing-relevant signal.

    Current behaviour: for ``POST /2/tweets`` classified as
    ``content.create_with_url``, drop to ``content.create`` when the
    tweet body is plain text with no URL, no quote reference and no
    media attachment.  All parse failures or ambiguity → stay on the
    more expensive bucket, matching the "never under-charge" rule.
    """
    if bucket != "content.create_with_url" or method != "POST" or path != "/2/tweets":
        return bucket
    if not body:
        return bucket
    try:
        obj = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return bucket
    if not isinstance(obj, dict):
        return bucket
    # Quote tweets embed a link to the quoted post; X likely bills
    # these as "with URL" on the rendered tweet.  Stay conservative.
    if obj.get("quote_tweet_id") is not None:
        return bucket
    # Attached media renders as a t.co preview URL in the published
    # tweet.  Stay conservative.
    media = obj.get("media")
    if isinstance(media, dict) and media.get("media_ids"):
        return bucket
    # A `card_uri` attaches a link preview card to the tweet — the
    # published post always renders a URL.  Treat as with-URL even
    # when the text itself is plain.
    if obj.get("card_uri"):
        return bucket
    text = obj.get("text")
    if not isinstance(text, str):
        return bucket
    if _tweet_text_likely_contains_url(text):
        return bucket
    return "content.create"
