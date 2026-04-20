"""Tests for graphql_fields module — nested field path extraction.

Test cases reference graphql-core's parser test suite, adapted to our
field-path-extraction use case.
"""

from typing import ClassVar

import pytest

from graphql_fields import Lexer, T, extract_field_paths

# =========================================================================
# Lexer tests
# =========================================================================


class TestLexerTokenization:
    """Verify the lexer produces correct token streams."""

    def _tokens(self, src: str) -> list[tuple[str, str]]:
        lex = Lexer(src)
        toks = []
        while True:
            t = lex.next_token()
            if t.kind == T.EOF:
                break
            toks.append((t.kind.name, t.value))
        return toks

    def test_simple_query(self):
        toks = self._tokens("{ viewer }")
        assert toks == [("BRACE_L", ""), ("NAME", "viewer"), ("BRACE_R", "")]

    def test_spread(self):
        toks = self._tokens("... on")
        assert toks == [("SPREAD", ""), ("NAME", "on")]

    def test_colon_and_at(self):
        toks = self._tokens("alias: field @dir")
        assert toks == [
            ("NAME", "alias"),
            ("COLON", ""),
            ("NAME", "field"),
            ("AT", ""),
            ("NAME", "dir"),
        ]

    def test_skips_whitespace_and_commas(self):
        toks = self._tokens("  a , b \n c \t d  ")
        names = [t[1] for t in toks]
        assert names == ["a", "b", "c", "d"]

    def test_skips_comments(self):
        toks = self._tokens("a # this is a comment\n b")
        names = [t[1] for t in toks]
        assert names == ["a", "b"]

    def test_skips_bom(self):
        """Byte Order Mark should be ignored."""
        toks = self._tokens("\ufeff{ viewer }")
        assert toks[0] == ("BRACE_L", "")

    def test_paren_token(self):
        toks = self._tokens("field(")
        assert toks == [("NAME", "field"), ("PAREN_L", "")]

    def test_name_with_underscores_and_digits(self):
        toks = self._tokens("_foo123 __typename _0")
        names = [t[1] for t in toks]
        assert names == ["_foo123", "__typename", "_0"]

    def test_empty_string(self):
        assert self._tokens("") == []

    def test_only_comments(self):
        assert self._tokens("# nothing here") == []


class TestLexerStringSkipping:
    """Strings inside arguments are handled by skip_balanced_parens.
    Verify they don't leak tokens."""

    def test_regular_string_in_parens(self):
        lex = Lexer('(name: "value")')
        assert lex.next_token().kind == T.PAREN_L
        lex.skip_balanced_parens()
        assert lex.next_token().kind == T.EOF

    def test_block_string_in_parens(self):
        lex = Lexer('(body: """block\n  string""")')
        assert lex.next_token().kind == T.PAREN_L
        lex.skip_balanced_parens()
        assert lex.next_token().kind == T.EOF

    def test_escaped_quote_in_parens(self):
        lex = Lexer(r'(title: "say \"hello\"")')
        assert lex.next_token().kind == T.PAREN_L
        lex.skip_balanced_parens()
        assert lex.next_token().kind == T.EOF

    def test_nested_parens(self):
        lex = Lexer("(a: (b: (c: 1)))")
        assert lex.next_token().kind == T.PAREN_L
        lex.skip_balanced_parens()
        assert lex.next_token().kind == T.EOF

    def test_comment_inside_parens(self):
        lex = Lexer("(a: 1 # comment\n)")
        assert lex.next_token().kind == T.PAREN_L
        lex.skip_balanced_parens()
        assert lex.next_token().kind == T.EOF

    def test_string_with_parens_inside(self):
        """Parens inside strings must not affect depth counting."""
        lex = Lexer('(title: "(((")')
        assert lex.next_token().kind == T.PAREN_L
        lex.skip_balanced_parens()
        assert lex.next_token().kind == T.EOF

    def test_block_string_with_escaped_triple_quote(self):
        lex = Lexer(r'(body: """contains \""" inside""")')
        assert lex.next_token().kind == T.PAREN_L
        lex.skip_balanced_parens()
        assert lex.next_token().kind == T.EOF


# =========================================================================
# Parser — core field extraction
# =========================================================================


class TestExtractFieldPaths:
    """Core field path extraction."""

    def test_empty_string(self):
        assert extract_field_paths("") == []

    def test_shorthand_query(self):
        assert extract_field_paths("{ viewer { login } }") == [
            "viewer",
            "viewer.login",
        ]

    def test_named_query(self):
        result = extract_field_paths("query GetViewer { viewer { login } }")
        assert result == ["viewer", "viewer.login"]

    def test_mutation(self):
        result = extract_field_paths(
            'mutation { createIssue(input: {title: "x"}) { issue { id } } }'
        )
        assert result == ["createIssue", "createIssue.issue", "createIssue.issue.id"]

    def test_subscription(self):
        result = extract_field_paths("subscription { issueUpdated { issue { title } } }")
        assert result == [
            "issueUpdated",
            "issueUpdated.issue",
            "issueUpdated.issue.title",
        ]

    def test_multiple_top_level_fields(self):
        result = extract_field_paths("{ viewer { login } rateLimit { remaining } }")
        assert result == [
            "viewer",
            "viewer.login",
            "rateLimit",
            "rateLimit.remaining",
        ]

    def test_deeply_nested(self):
        query = """query {
            repository(owner: "o", name: "n") {
                issues(first: 10) {
                    nodes {
                        title
                        author { login }
                    }
                }
            }
        }"""
        result = extract_field_paths(query)
        assert result == [
            "repository",
            "repository.issues",
            "repository.issues.nodes",
            "repository.issues.nodes.title",
            "repository.issues.nodes.author",
            "repository.issues.nodes.author.login",
        ]

    def test_flat_mutation_fields(self):
        """Top-level mutation fields (no nesting) — backward compatible."""
        result = extract_field_paths("mutation { createIssue addComment deleteIssue }")
        assert result == ["createIssue", "addComment", "deleteIssue"]


# =========================================================================
# Aliases
# =========================================================================


class TestAliases:
    """Alias handling — should return actual field name, not alias."""

    def test_simple_alias(self):
        result = extract_field_paths("{ myRepo: repository { name } }")
        assert result == ["repository", "repository.name"]

    def test_nested_alias(self):
        result = extract_field_paths(
            "{ repository { openIssues: issues(states: OPEN) { totalCount } } }"
        )
        assert result == [
            "repository",
            "repository.issues",
            "repository.issues.totalCount",
        ]

    def test_alias_with_arguments(self):
        result = extract_field_paths(
            '{ first: user(login: "a") { name } second: user(login: "b") { name } }'
        )
        assert result == ["user", "user.name", "user", "user.name"]

    def test_alias_with_selection_set(self):
        """graphql-core kitchen sink: whoever123is: node(id: [123, 456]) { id }"""
        result = extract_field_paths("{ whoever123is: node(id: [123, 456]) { id } }")
        assert result == ["node", "node.id"]

    def test_deeply_nested_alias(self):
        query = """{
            repository {
                openPRs: pullRequests(states: OPEN) {
                    nodes {
                        myTitle: title
                    }
                }
            }
        }"""
        result = extract_field_paths(query)
        assert result == [
            "repository",
            "repository.pullRequests",
            "repository.pullRequests.nodes",
            "repository.pullRequests.nodes.title",
        ]

    def test_multiple_aliases_same_field(self):
        """Multiple aliases of the same field at the same level."""
        result = extract_field_paths(
            '{ a: user(id: "1") { name } b: user(id: "2") { name } c: user(id: "3") { name } }'
        )
        assert result == ["user", "user.name", "user", "user.name", "user", "user.name"]


# =========================================================================
# Arguments
# =========================================================================


class TestArguments:
    """Arguments should be skipped, not extracted as fields."""

    def test_arguments_not_extracted(self):
        result = extract_field_paths('{ repository(owner: "foo", name: "bar") { name } }')
        assert result == ["repository", "repository.name"]

    def test_nested_object_arguments(self):
        result = extract_field_paths(
            'mutation { createIssue(input: {title: "test", body: "content"}) { issue { id } } }'
        )
        assert result == ["createIssue", "createIssue.issue", "createIssue.issue.id"]

    def test_string_in_arguments(self):
        """Field-like strings inside arguments must not leak as field names."""
        result = extract_field_paths(
            'mutation { createIssue(input: {title: "fakeField"}) { issue { id } } }'
        )
        assert "fakeField" not in result

    def test_array_arguments(self):
        result = extract_field_paths("{ node(id: [1, 2, 3]) { name } }")
        assert result == ["node", "node.name"]

    def test_variable_arguments(self):
        result = extract_field_paths("query Q($id: ID!) { node(id: $id) { name } }")
        assert result == ["node", "node.name"]

    def test_enum_arguments(self):
        result = extract_field_paths("{ issues(state: OPEN, orderBy: CREATED_AT) { totalCount } }")
        assert result == ["issues", "issues.totalCount"]

    def test_deeply_nested_object_arguments(self):
        """Complex nested input objects in arguments."""
        query = (
            "mutation { createIssue(input: "
            '{repo: {owner: "o", name: "n"}, title: "t", labels: ["bug"]})'
            " { id } }"
        )
        result = extract_field_paths(query)
        assert result == ["createIssue", "createIssue.id"]

    def test_trailing_comma_in_arguments(self):
        """graphql-core kitchen sink: field1(first:10, after:$foo,)"""
        result = extract_field_paths("{ field1(first: 10, after: $foo,) { id } }")
        assert result == ["field1", "field1.id"]


# =========================================================================
# Strings and comments
# =========================================================================


class TestStringsAndComments:
    """String literals and comments must not produce field names."""

    def test_comment_ignored(self):
        query = """{
            # this is viewer
            viewer { login }
        }"""
        result = extract_field_paths(query)
        assert result == ["viewer", "viewer.login"]

    def test_block_string_ignored(self):
        query = '''mutation {
            createIssue(input: {body: """
                fakeField { nested }
            """}) { issue { id } }
        }'''
        result = extract_field_paths(query)
        assert "fakeField" not in result
        assert "nested" not in result
        assert "createIssue" in result

    def test_string_with_braces(self):
        query = 'mutation { createIssue(input: {title: "{ fakeField }"}) { id } }'
        result = extract_field_paths(query)
        assert "fakeField" not in result

    def test_escaped_string(self):
        query = r'mutation { createIssue(input: {title: "test \"fakeField\""}) { id } }'
        result = extract_field_paths(query)
        assert "fakeField" not in result

    def test_comment_between_fields(self):
        query = """{
            viewer {
                login
                # separator comment
                name
                # trailing comment
            }
        }"""
        result = extract_field_paths(query)
        assert result == ["viewer", "viewer.login", "viewer.name"]

    def test_comment_after_field(self):
        result = extract_field_paths("{ field1 # comment\n field2 }")
        assert result == ["field1", "field2"]

    def test_block_string_with_triple_quote_escape(self):
        r"""Block strings: \""" is an escape for literal triple-quote."""
        query = 'mutation { createIssue(input: {body: """contains \\""" triple"""}) { id } }'
        result = extract_field_paths(query)
        assert result == ["createIssue", "createIssue.id"]

    def test_empty_string_argument(self):
        result = extract_field_paths('{ field(name: "") { id } }')
        assert result == ["field", "field.id"]

    def test_empty_block_string_argument(self):
        result = extract_field_paths('{ field(name: """""") { id } }')
        assert result == ["field", "field.id"]

    def test_string_with_escaped_special_chars(self):
        """graphql-core: escaped \\n\\r\\b\\t\\f"""
        result = extract_field_paths(r'{ field(val: "escaped \n\r\b\t\f") { id } }')
        assert result == ["field", "field.id"]

    def test_string_with_unicode_escape(self):
        result = extract_field_paths(r'{ field(val: "\u1234") { id } }')
        assert result == ["field", "field.id"]

    def test_block_string_no_escape_sequences(self):
        """Block strings don't process escape sequences."""
        query = '{ field(val: """unescaped \\n\\r\\b""") { id } }'
        result = extract_field_paths(query)
        assert result == ["field", "field.id"]

    def test_string_with_parens_inside(self):
        """Parens inside strings must not break argument skipping."""
        result = extract_field_paths('{ field(val: "(((") { id } }')
        assert result == ["field", "field.id"]

    def test_string_with_braces_inside(self):
        """Braces inside strings must not break scope tracking."""
        result = extract_field_paths('{ field(val: "}}}{{{") { id } }')
        assert result == ["field", "field.id"]


# =========================================================================
# Fragments
# =========================================================================


class TestFragments:
    """Fragment spread and inline fragment handling."""

    def test_inline_fragment_fields_at_parent_level(self):
        """Inline fragment fields should be attributed to the parent path."""
        query = """{
            node(id: "x") {
                ... on Issue {
                    title
                    body
                }
                ... on PullRequest {
                    mergeable
                }
            }
        }"""
        result = extract_field_paths(query)
        assert "node" in result
        assert "node.title" in result
        assert "node.body" in result
        assert "node.mergeable" in result

    def test_named_fragment_spread_skipped(self):
        """Named fragment spreads cannot be resolved — just skip them."""
        query = """{
            viewer {
                ...UserFields
                login
            }
        }"""
        result = extract_field_paths(query)
        assert result == ["viewer", "viewer.login"]
        assert "UserFields" not in result

    def test_inline_fragment_without_type_condition(self):
        query = """{
            viewer {
                ... {
                    login
                    name
                }
            }
        }"""
        result = extract_field_paths(query)
        assert "viewer.login" in result
        assert "viewer.name" in result

    def test_inline_fragment_without_type_followed_by_sibling(self):
        """Sibling fields after inline fragment must not be lost."""
        query = """{
            viewer {
                ... {
                    login
                }
                email
            }
        }"""
        result = extract_field_paths(query)
        assert "viewer.login" in result
        assert "viewer.email" in result

    def test_inline_fragment_with_type_followed_by_sibling(self):
        """Sibling fields after typed inline fragment must not be lost."""
        query = """{
            node(id: "x") {
                ... on Issue {
                    title
                }
                id
            }
        }"""
        result = extract_field_paths(query)
        assert "node.title" in result
        assert "node.id" in result

    def test_named_spread_followed_by_sibling(self):
        """Sibling fields after named spread must not be lost."""
        query = """{
            viewer {
                ...UserFields
                email
                name
            }
        }"""
        result = extract_field_paths(query)
        assert "viewer.email" in result
        assert "viewer.name" in result

    def test_nested_inline_fragments(self):
        """Inline fragments nested inside inline fragments."""
        query = """{
            node(id: "x") {
                ... on Issue {
                    ... on LabelableNode {
                        labels { name }
                    }
                    title
                }
            }
        }"""
        result = extract_field_paths(query)
        assert "node.labels" in result
        assert "node.labels.name" in result
        assert "node.title" in result

    def test_inline_fragment_at_top_level(self):
        """graphql-core kitchen sink: ... @skip(unless: $foo) { id }"""
        query = """{
            whoever123is: node(id: [123, 456]) {
                id
                ... on User {
                    field2 { id }
                }
                ... @skip(unless: $foo) {
                    id
                }
                ... {
                    id
                }
            }
        }"""
        result = extract_field_paths(query)
        assert "node" in result
        assert "node.id" in result
        assert "node.field2" in result
        assert "node.field2.id" in result

    def test_mixed_spreads_inline_and_fields(self):
        """Complex mix of all selection types."""
        query = """{
            viewer {
                ...BasicInfo
                ... on User {
                    organizations { name }
                }
                ... {
                    avatarUrl
                }
                login
            }
        }"""
        result = extract_field_paths(query)
        assert "viewer.organizations" in result
        assert "viewer.organizations.name" in result
        assert "viewer.avatarUrl" in result
        assert "viewer.login" in result
        assert "BasicInfo" not in result

    def test_fragment_spread_with_directives(self):
        """graphql-core kitchen sink: ...frag @onFragmentSpread"""
        query = """{
            viewer {
                ...frag @onFragmentSpread
                login
            }
        }"""
        result = extract_field_paths(query)
        assert result == ["viewer", "viewer.login"]


# =========================================================================
# Directives
# =========================================================================


class TestDirectives:
    """Directives should be skipped properly."""

    def test_field_directive(self):
        result = extract_field_paths("{ viewer { login @include(if: true) name } }")
        assert result == ["viewer", "viewer.login", "viewer.name"]

    def test_operation_directive(self):
        result = extract_field_paths("query @cached { viewer { login } }")
        assert result == ["viewer", "viewer.login"]

    def test_inline_fragment_directive(self):
        query = """{
            node(id: "x") {
                ... on Issue @include(if: true) {
                    title
                }
            }
        }"""
        result = extract_field_paths(query)
        assert "node.title" in result

    def test_multiple_directives_on_field(self):
        result = extract_field_paths("{ viewer { login @skip(if: $a) @include(if: $b) } }")
        assert result == ["viewer", "viewer.login"]

    def test_directive_without_arguments(self):
        result = extract_field_paths("{ viewer { login @deprecated } }")
        assert result == ["viewer", "viewer.login"]

    def test_directive_on_selection_set_field(self):
        """Directive on a field that has a sub-selection set."""
        result = extract_field_paths("{ viewer @include(if: true) { login } }")
        assert result == ["viewer", "viewer.login"]

    def test_directive_on_inline_fragment_without_type(self):
        """graphql-core: ... @skip(unless: $foo) { id }"""
        query = """{
            node {
                ... @skip(unless: $foo) {
                    id
                }
                name
            }
        }"""
        result = extract_field_paths(query)
        assert "node.id" in result
        assert "node.name" in result

    def test_multiple_operation_directives(self):
        result = extract_field_paths("query @a @b(x: 1) @c { viewer { login } }")
        assert result == ["viewer", "viewer.login"]


# =========================================================================
# Variable definitions
# =========================================================================


class TestVariableDefinitions:
    """Variable definitions should be skipped."""

    def test_query_with_variables(self):
        query = (
            "query GetRepo($owner: String!, $name: String!)"
            " { repository(owner: $owner, name: $name) { name } }"
        )
        result = extract_field_paths(query)
        assert result == ["repository", "repository.name"]

    def test_mutation_with_variables(self):
        query = (
            "mutation CreateIssue($input: CreateIssueInput!)"
            " { createIssue(input: $input) { issue { id } } }"
        )
        result = extract_field_paths(query)
        assert result == ["createIssue", "createIssue.issue", "createIssue.issue.id"]

    def test_complex_variable_types(self):
        """Variables with default values and complex types."""
        result = extract_field_paths(
            "query Q($foo: ComplexType, $site: Site = MOBILE) { field { id } }"
        )
        assert result == ["field", "field.id"]

    def test_variable_with_directive(self):
        """graphql-core: query Foo($x: Boolean = false @bar) { field }"""
        result = extract_field_paths("query Foo($x: Boolean = false @bar) { field }")
        assert result == ["field"]

    def test_variable_with_object_default(self):
        """graphql-core: ($foo: TestType = {a: 123} @testDirective(if: true))"""
        result = extract_field_paths(
            "query ($foo: TestType = {a: 123} @testDirective(if: true) @test) { id }"
        )
        assert result == ["id"]


# =========================================================================
# Keywords as field names
# =========================================================================


class TestKeywordsAsNames:
    """GraphQL keywords can be used as field names (they are contextual)."""

    def test_query_as_field_name(self):
        result = extract_field_paths("{ query { id } }")
        assert result == ["query", "query.id"]

    def test_mutation_as_field_name(self):
        result = extract_field_paths("query { mutation { id } }")
        assert result == ["mutation", "mutation.id"]

    def test_subscription_as_field_name(self):
        result = extract_field_paths("{ subscription { id } }")
        assert result == ["subscription", "subscription.id"]

    def test_fragment_as_field_name(self):
        result = extract_field_paths("{ fragment { id } }")
        assert result == ["fragment", "fragment.id"]

    def test_on_as_field_name(self):
        result = extract_field_paths("{ on { id } }")
        assert result == ["on", "on.id"]

    def test_true_false_null_as_field_names(self):
        """These are reserved in enum values but valid as field names."""
        result = extract_field_paths("{ true false null }")
        assert result == ["true", "false", "null"]

    def test_type_as_field_name(self):
        result = extract_field_paths("{ type { id } }")
        assert result == ["type", "type.id"]

    def test_mixed_keywords_as_fields(self):
        """graphql-core inspired: keywords in various positions."""
        result = extract_field_paths("query query { query(query: $query) { query } }")
        assert result == ["query", "query.query"]


# =========================================================================
# Edge cases
# =========================================================================


class TestEdgeCases:
    """Edge cases and malformed input."""

    def test_no_selection_set(self):
        assert extract_field_paths("query") == []

    def test_only_braces(self):
        assert extract_field_paths("{}") == []

    def test_whitespace_only(self):
        assert extract_field_paths("   ") == []

    def test_compact_syntax(self):
        """No spaces between tokens."""
        result = extract_field_paths("{viewer{login}}")
        assert result == ["viewer", "viewer.login"]

    def test_commas_as_separators(self):
        """Commas are insignificant in GraphQL."""
        result = extract_field_paths("{ viewer { login, name, email } }")
        assert result == ["viewer", "viewer.login", "viewer.name", "viewer.email"]

    def test_multiple_operations_only_first(self):
        """Only the first operation is parsed (matching real request behavior)."""
        result = extract_field_paths("query A { viewer { login } }")
        assert result == ["viewer", "viewer.login"]

    def test_none_input(self):
        assert extract_field_paths(None) == []  # type: ignore[arg-type]

    def test_bom_prefix(self):
        """Byte Order Mark should be transparently skipped."""
        result = extract_field_paths("\ufeff{ viewer { login } }")
        assert result == ["viewer", "viewer.login"]

    def test_crlf_line_endings(self):
        result = extract_field_paths("{\r\n  viewer {\r\n    login\r\n  }\r\n}")
        assert result == ["viewer", "viewer.login"]

    def test_tab_indentation(self):
        result = extract_field_paths("{\n\tviewer {\n\t\tlogin\n\t}\n}")
        assert result == ["viewer", "viewer.login"]

    def test_extreme_nesting(self):
        """Deeply nested selection sets."""
        query = "{ a { b { c { d { e { f { g { h { i { j } } } } } } } } }"
        result = extract_field_paths(query)
        assert result[-1] == "a.b.c.d.e.f.g.h.i.j"
        assert len(result) == 10

    def test_many_fields_at_same_level(self):
        fields = " ".join(f"f{i}" for i in range(100))
        result = extract_field_paths("{ " + fields + " }")
        assert len(result) == 100
        assert result[0] == "f0"
        assert result[99] == "f99"

    def test_underscore_only_field(self):
        result = extract_field_paths("{ _ { __ } }")
        assert result == ["_", "_.__"]

    def test_typename_field(self):
        """__typename is a valid introspection field."""
        result = extract_field_paths("{ __typename viewer { __typename login } }")
        assert result == ["__typename", "viewer", "viewer.__typename", "viewer.login"]

    def test_field_after_empty_inline_fragment(self):
        """Empty inline fragment followed by fields."""
        query = """{
            viewer {
                ... on User {}
                login
            }
        }"""
        result = extract_field_paths(query)
        assert "viewer.login" in result

    def test_consecutive_inline_fragments(self):
        """Multiple inline fragments in sequence."""
        query = """{
            node {
                ... on Issue { title }
                ... on PR { number }
                ... on Discussion { body }
                id
            }
        }"""
        result = extract_field_paths(query)
        assert "node.title" in result
        assert "node.number" in result
        assert "node.body" in result
        assert "node.id" in result

    def test_consecutive_named_spreads(self):
        """Multiple named spreads in sequence."""
        query = """{
            viewer {
                ...A
                ...B
                ...C
                login
            }
        }"""
        result = extract_field_paths(query)
        assert result == ["viewer", "viewer.login"]


# =========================================================================
# Kitchen sink (adapted from graphql-core's test fixture)
# =========================================================================


class TestKitchenSink:
    """Complex real-world queries from graphql-core's kitchen sink fixture."""

    def test_kitchen_sink_query(self):
        """Adapted from graphql-core tests/fixtures/kitchen_sink.graphql"""
        query = """query queryName($foo: ComplexType, $site: Site = MOBILE) @onQuery {
            whoever123is: node(id: [123, 456]) {
                id,
                ... on User @onInlineFragment {
                    field2 {
                        id,
                        alias: field1(first:10, after:$foo,) @include(if: $foo) {
                            id,
                            ...frag @onFragmentSpread
                        }
                    }
                }
                ... @skip(unless: $foo) {
                    id
                }
                ... {
                    id
                }
            }
        }"""
        result = extract_field_paths(query)
        assert "node" in result
        assert "node.id" in result
        assert "node.field2" in result
        assert "node.field2.id" in result
        assert "node.field2.field1" in result  # alias resolved
        assert "node.field2.field1.id" in result

    def test_kitchen_sink_mutation(self):
        query = """mutation likeStory @onMutation {
            like(story: 123) @onField {
                story {
                    id @onField
                }
            }
        }"""
        result = extract_field_paths(query)
        assert result == ["like", "like.story", "like.story.id"]

    def test_kitchen_sink_subscription(self):
        query = """subscription StoryLikeSubscription(
            $input: StoryLikeSubscribeInput @onVariableDefinition
        ) @onSubscription {
            storyLikeSubscribe(input: $input) {
                story {
                    likers { count }
                    likeSentence { text }
                }
            }
        }"""
        result = extract_field_paths(query)
        assert result == [
            "storyLikeSubscribe",
            "storyLikeSubscribe.story",
            "storyLikeSubscribe.story.likers",
            "storyLikeSubscribe.story.likers.count",
            "storyLikeSubscribe.story.likeSentence",
            "storyLikeSubscribe.story.likeSentence.text",
        ]

    def test_github_issue_create(self):
        """Real gh CLI mutation for creating an issue."""
        query = """mutation IssueCreate($input: CreateIssueInput!) {
            createIssue(input: $input) {
                issue {
                    id
                    url
                    title
                    body
                    state
                    number
                    author { login }
                    labels(first: 100) { nodes { name } }
                    assignees(first: 100) { nodes { login } }
                }
            }
        }"""
        result = extract_field_paths(query)
        assert "createIssue" in result
        assert "createIssue.issue" in result
        assert "createIssue.issue.id" in result
        assert "createIssue.issue.url" in result
        assert "createIssue.issue.author" in result
        assert "createIssue.issue.author.login" in result
        assert "createIssue.issue.labels" in result
        assert "createIssue.issue.labels.nodes" in result
        assert "createIssue.issue.labels.nodes.name" in result

    def test_github_repository_query(self):
        """Real gh CLI query for repository info."""
        query = """query RepositoryInfo($owner: String!, $name: String!) {
            repository(owner: $owner, name: $name) {
                id
                name
                nameWithOwner
                description
                url
                isPrivate
                defaultBranchRef { name }
                issues(first: 5, states: OPEN) {
                    totalCount
                    nodes { title number }
                }
                pullRequests(first: 5, states: OPEN) {
                    totalCount
                    nodes { title number }
                }
            }
        }"""
        result = extract_field_paths(query)
        assert "repository" in result
        assert "repository.id" in result
        assert "repository.defaultBranchRef" in result
        assert "repository.defaultBranchRef.name" in result
        assert "repository.issues" in result
        assert "repository.issues.totalCount" in result
        assert "repository.issues.nodes" in result
        assert "repository.issues.nodes.title" in result
        assert "repository.pullRequests" in result
        assert "repository.pullRequests.nodes" in result

    def test_github_viewer_query(self):
        """Real gh CLI query for current user."""
        query = """query {
            viewer {
                login
                name
                email
                organizations(first: 100) {
                    nodes {
                        login
                        name
                    }
                }
            }
        }"""
        result = extract_field_paths(query)
        assert result == [
            "viewer",
            "viewer.login",
            "viewer.name",
            "viewer.email",
            "viewer.organizations",
            "viewer.organizations.nodes",
            "viewer.organizations.nodes.login",
            "viewer.organizations.nodes.name",
        ]


# =========================================================================
# Security: injection resistance
# =========================================================================


class TestSecurityInjection:
    """Verify that malicious input cannot inject fake field names."""

    def test_string_injection_field_name(self):
        """String containing field-like content must not produce paths."""
        query = 'mutation { createIssue(input: {title: "deleteRepo"}) { id } }'
        result = extract_field_paths(query)
        assert "deleteRepo" not in result

    def test_comment_injection_field_name(self):
        """Comment cannot inject field names."""
        query = "{ viewer { login } } # deleteRepo"
        result = extract_field_paths(query)
        assert "deleteRepo" not in result

    def test_block_string_injection_selection(self):
        """Block string containing a selection set must not produce paths."""
        query = '''mutation {
            createIssue(input: {body: """
                { deleteRepo { id } }
            """}) { id }
        }'''
        result = extract_field_paths(query)
        assert "deleteRepo" not in result

    def test_string_with_spread_syntax(self):
        """String containing ... spread syntax must not trigger fragment parsing."""
        query = 'mutation { createIssue(input: {title: "...fakeFragment"}) { id } }'
        result = extract_field_paths(query)
        assert "fakeFragment" not in result

    def test_string_with_at_directive(self):
        """String containing @ directive syntax must not trigger directive parsing."""
        query = 'mutation { createIssue(input: {title: "@include(if: true)"}) { id } }'
        result = extract_field_paths(query)
        assert "include" not in result

    def test_string_with_colon_alias(self):
        """String containing colon must not be parsed as alias."""
        query = 'mutation { createIssue(input: {title: "alias: realField"}) { id } }'
        result = extract_field_paths(query)
        assert "realField" not in result

    def test_unterminated_string_does_not_crash(self):
        """Unterminated string should not crash — graceful degradation."""
        query = '{ field(name: "unterminated) { id } }'
        # Should not raise
        result = extract_field_paths(query)
        assert isinstance(result, list)

    def test_unterminated_block_string_does_not_crash(self):
        query = '{ field(name: """unterminated) { id } }'
        result = extract_field_paths(query)
        assert isinstance(result, list)

    def test_deeply_nested_parens_in_arguments(self):
        """Deep paren nesting must not break argument skipping."""
        query = "{ field(a: ((((((1))))))) { id } }"
        result = extract_field_paths(query)
        assert result == ["field", "field.id"]


# =========================================================================
# Full kitchen sink (graphql-core fixture, verbatim)
# =========================================================================


class TestFullKitchenSink:
    """The complete kitchen_sink.graphql from graphql-core.

    We parse each operation separately since our parser handles single
    operations.  Fragment definitions at the end are skipped (no selection
    set for the parser to enter).
    """

    KITCHEN_SINK_QUERY = """\
query queryName($foo: ComplexType, $site: Site = MOBILE) @onQuery {
  whoever123is: node(id: [123, 456]) {
    id ,
    ... on User @onInlineFragment {
      field2 {
        id ,
        alias: field1(first:10, after:$foo,) @include(if: $foo) {
          id,
          ...frag @onFragmentSpread
        }
      }
    }
    ... @skip(unless: $foo) {
      id
    }
    ... {
      id
    }
  }
}"""

    KITCHEN_SINK_MUTATION = """\
mutation likeStory @onMutation {
  like(story: 123) @onField {
    story {
      id @onField
    }
  }
}"""

    KITCHEN_SINK_SUBSCRIPTION = """\
subscription StoryLikeSubscription(
  $input: StoryLikeSubscribeInput @onVariableDefinition
) @onSubscription {
  storyLikeSubscribe(input: $input) {
    story {
      likers {
        count
      }
      likeSentence {
        text
      }
    }
  }
}"""

    KITCHEN_SINK_SHORTHAND = """\
{
  unnamed(truthy: true, falsy: false, nullish: null),
  query
}"""

    def test_kitchen_sink_query_fields(self):
        result = extract_field_paths(self.KITCHEN_SINK_QUERY)
        assert "node" in result
        assert "node.id" in result
        # ... on User { field2 { ... } } — inline fragment at parent level
        assert "node.field2" in result
        assert "node.field2.id" in result
        # alias: field1 → field1
        assert "node.field2.field1" in result
        assert "node.field2.field1.id" in result
        # ...frag is a named spread, skipped — no "frag" path
        assert all("frag" not in p for p in result)

    def test_kitchen_sink_mutation_fields(self):
        result = extract_field_paths(self.KITCHEN_SINK_MUTATION)
        assert result == ["like", "like.story", "like.story.id"]

    def test_kitchen_sink_subscription_fields(self):
        result = extract_field_paths(self.KITCHEN_SINK_SUBSCRIPTION)
        assert result == [
            "storyLikeSubscribe",
            "storyLikeSubscribe.story",
            "storyLikeSubscribe.story.likers",
            "storyLikeSubscribe.story.likers.count",
            "storyLikeSubscribe.story.likeSentence",
            "storyLikeSubscribe.story.likeSentence.text",
        ]

    def test_kitchen_sink_shorthand(self):
        result = extract_field_paths(self.KITCHEN_SINK_SHORTHAND)
        assert result == ["unnamed", "query"]

    def test_kitchen_sink_typename_query(self):
        result = extract_field_paths("query { __typename }")
        assert result == ["__typename"]

    def test_kitchen_sink_query_all_inline_fragments(self):
        """All three inline fragment forms appear in the query."""
        result = extract_field_paths(self.KITCHEN_SINK_QUERY)
        # ... on User { ... } — typed inline fragment
        # ... @skip(...) { id } — directive-only inline fragment
        # ... { id } — bare inline fragment
        # All contribute "node.id" (from different fragments)
        assert result.count("node.id") == 3


# =========================================================================
# graphql-core parser test cases (ported)
# =========================================================================


class TestGraphQLCoreParserPorted:
    """Test cases from graphql-core's test_parser.py, adapted for field
    extraction (we only care about which fields are extracted, not AST)."""

    def test_simple_field(self):
        """parse('{ foo }')"""
        assert extract_field_paths("{ foo }") == ["foo"]

    def test_field_with_string_argument(self):
        """parse('{ foo(bar: "baz") }')"""
        assert extract_field_paths('{ foo(bar: "baz") }') == ["foo"]

    def test_nested_selection_set(self):
        """parse('{ node(id: 4) { id, name } }')"""
        assert extract_field_paths("{ node(id: 4) { id, name } }") == [
            "node",
            "node.id",
            "node.name",
        ]

    def test_complex_nested_argument(self):
        """parse('{ field(complex: { a: { b: [ $var ] } }) }')"""
        assert extract_field_paths("{ field(complex: { a: { b: [ $var ] } }) }") == ["field"]

    def test_variable_with_complex_default(self):
        """parse('query Foo($x: Complex = { a: { b: [ $var ] } }) { field }')"""
        assert extract_field_paths("query Foo($x: Complex = { a: { b: [ $var ] } }) { field }") == [
            "field"
        ]

    def test_nameless_mutation(self):
        """parse('mutation { mutationField }')"""
        assert extract_field_paths("mutation { mutationField }") == [
            "mutationField",
        ]

    def test_named_mutation(self):
        """parse('mutation Foo { mutationField }')"""
        assert extract_field_paths("mutation Foo { mutationField }") == [
            "mutationField",
        ]

    def test_nameless_subscription(self):
        """parse('subscription { subscriptionField }')"""
        assert extract_field_paths("subscription { subscriptionField }") == [
            "subscriptionField",
        ]

    def test_named_subscription(self):
        """parse('subscription Foo { subscriptionField }')"""
        assert extract_field_paths("subscription Foo { subscriptionField }") == [
            "subscriptionField",
        ]

    def test_nameless_query_with_field(self):
        """parse('query { node { id } }')"""
        assert extract_field_paths("query { node { id } }") == [
            "node",
            "node.id",
        ]


class TestGraphQLCoreKeywordsAsNames:
    """graphql-core: all non-reserved keywords are valid as names.

    Ported from the parametrized ``test_parses_keyword_as_name`` test
    which iterates over all GraphQL keywords.
    """

    KEYWORDS: ClassVar[list[str]] = [
        "on",
        "fragment",
        "query",
        "mutation",
        "subscription",
        "true",
        "false",
        "null",
        "schema",
        "scalar",
        "type",
        "interface",
        "union",
        "enum",
        "input",
        "extend",
        "directive",
        "implements",
        "repeatable",
    ]

    @pytest.mark.parametrize("keyword", KEYWORDS)
    def test_keyword_as_field_name(self, keyword: str):
        """Each keyword should work as a field name."""
        result = extract_field_paths("{ " + keyword + " }")
        assert result == [keyword]

    @pytest.mark.parametrize("keyword", KEYWORDS)
    def test_keyword_as_nested_field(self, keyword: str):
        result = extract_field_paths("{ parent { " + keyword + " } }")
        assert result == ["parent", f"parent.{keyword}"]

    @pytest.mark.parametrize("keyword", KEYWORDS)
    def test_keyword_as_alias(self, keyword: str):
        """Keyword used as alias — actual field name should be extracted."""
        result = extract_field_paths("{ " + keyword + ": realField }")
        assert result == ["realField"]

    @pytest.mark.parametrize("keyword", [k for k in KEYWORDS if k != "on"])
    def test_keyword_in_fragment_spread_context(self, keyword: str):
        """``...keyword`` should be treated as fragment spread, not field."""
        query = "{ parent { ..." + keyword + " field } }"
        result = extract_field_paths(query)
        assert "parent.field" in result
        # Named spread name should not appear as a path
        assert keyword not in result

    def test_on_after_spread_is_inline_fragment(self):
        """``...on TypeName { ... }`` is an inline fragment, not a spread named 'on'."""
        query = "{ parent { ... on SomeType { nested } field } }"
        result = extract_field_paths(query)
        assert "parent.nested" in result
        assert "parent.field" in result


class TestGraphQLCoreComments:
    """graphql-core comment handling tests."""

    def test_comment_at_top(self):
        query = "# top comment\n{ field }"
        assert extract_field_paths(query) == ["field"]

    def test_comment_at_bottom(self):
        query = "{ field }\n# bottom comment"
        assert extract_field_paths(query) == ["field"]

    def test_comment_on_field(self):
        query = "{\n  field # field comment\n}"
        assert extract_field_paths(query) == ["field"]

    def test_comments_everywhere(self):
        query = """\
# top comment
{
  # before field
  field1  # after field1
  # between fields
  field2
  # after field2
}
# bottom comment
"""
        assert extract_field_paths(query) == ["field1", "field2"]

    def test_comment_in_argument_block(self):
        query = "{ field(arg: 1 # comment in args\n) { id } }"
        assert extract_field_paths(query) == ["field", "field.id"]


# =========================================================================
# graphql-core lexer test cases (ported for string handling)
# =========================================================================


class TestGraphQLCoreLexerStrings:
    """String literal edge cases from graphql-core's test_lexer.py.

    These verify that strings inside arguments don't leak field names.
    """

    def test_empty_regular_string(self):
        result = extract_field_paths('{ field(val: "") { id } }')
        assert result == ["field", "field.id"]

    def test_string_with_whitespace(self):
        result = extract_field_paths('{ field(val: " white space ") { id } }')
        assert result == ["field", "field.id"]

    def test_string_with_escaped_quote(self):
        result = extract_field_paths(r'{ field(val: "quote \"") { id } }')
        assert result == ["field", "field.id"]

    def test_string_with_escaped_chars(self):
        result = extract_field_paths(r'{ field(val: "escaped \n\r\b\t\f") { id } }')
        assert result == ["field", "field.id"]

    def test_string_with_escaped_slashes(self):
        result = extract_field_paths(r'{ field(val: "slashes \\ \/") { id } }')
        assert result == ["field", "field.id"]

    def test_string_with_unicode_escape(self):
        result = extract_field_paths(r'{ field(val: "\u1234\u5678") { id } }')
        assert result == ["field", "field.id"]

    def test_empty_block_string(self):
        result = extract_field_paths('{ field(val: """""") { id } }')
        assert result == ["field", "field.id"]

    def test_simple_block_string(self):
        result = extract_field_paths('{ field(val: """simple""") { id } }')
        assert result == ["field", "field.id"]

    def test_block_string_with_whitespace(self):
        result = extract_field_paths('{ field(val: """ white space """) { id } }')
        assert result == ["field", "field.id"]

    def test_multiline_block_string(self):
        result = extract_field_paths('{ field(val: """multi\nline""") { id } }')
        assert result == ["field", "field.id"]

    def test_block_string_unescaped_sequences(self):
        """Block strings don't process \\n etc."""
        result = extract_field_paths(r'{ field(val: """unescaped \n\r\b\t\f\u1234""") { id } }')
        assert result == ["field", "field.id"]

    def test_block_string_with_indentation(self):
        query = (
            '{ field(val: """\n        spans\n'
            "          multiple\n            lines\n\n"
            '        """) { id } }'
        )
        result = extract_field_paths(query)
        assert result == ["field", "field.id"]

    def test_block_string_containing_field_like_content(self):
        """Block string with GraphQL-like content must not leak paths."""
        query = '{ field(val: """{ fakeField(arg: 1) { nested } }""") { id } }'
        result = extract_field_paths(query)
        assert result == ["field", "field.id"]
        assert "fakeField" not in result

    def test_block_string_containing_spread(self):
        query = '{ field(val: """...fakeFragment""") { id } }'
        result = extract_field_paths(query)
        assert result == ["field", "field.id"]
        assert "fakeFragment" not in result

    def test_string_with_field_name_and_braces(self):
        """String ``"{ viewer { login } }"`` must not produce paths."""
        result = extract_field_paths('{ field(val: "{ viewer { login } }") { id } }')
        assert result == ["field", "field.id"]
        assert "viewer" not in result

    def test_string_with_newline_escape(self):
        r"""String containing ``\n`` followed by a field name."""
        result = extract_field_paths('{ field(val: "line1\\nfakeField") { id } }')
        assert result == ["field", "field.id"]
        assert "fakeField" not in result


class TestGraphQLCoreMultiByteAndUnicode:
    """Multi-byte character and BOM tests from graphql-core."""

    def test_bom_is_skipped(self):
        result = extract_field_paths("\ufeff{ field }")
        assert result == ["field"]

    def test_bom_in_middle_ignored(self):
        """BOM in the middle should be treated as whitespace."""
        result = extract_field_paths("{ field1\ufeff field2 }")
        assert result == ["field1", "field2"]

    def test_various_line_endings(self):
        """\\n, \\r, \\r\\n should all work."""
        assert extract_field_paths("{\nfield\n}") == ["field"]
        assert extract_field_paths("{\rfield\r}") == ["field"]
        assert extract_field_paths("{\r\nfield\r\n}") == ["field"]

    def test_mixed_line_endings(self):
        result = extract_field_paths("{\n field1 \r\n field2 \r field3 \n}")
        assert result == ["field1", "field2", "field3"]


# =========================================================================
# Robustness: malformed / partial input (graceful degradation)
# =========================================================================


class TestGracefulDegradation:
    """Our parser must never crash on malformed input.

    Unlike graphql-core which raises SyntaxError, we silently degrade
    because we're in a security-critical path (mitmproxy addon).
    """

    def test_incomplete_query_brace(self):
        """graphql-core: parse('{')"""
        result = extract_field_paths("{")
        assert isinstance(result, list)

    def test_missing_closing_brace(self):
        result = extract_field_paths("{ field")
        assert "field" in result

    def test_missing_opening_brace(self):
        result = extract_field_paths("query field }")
        assert isinstance(result, list)

    def test_extra_closing_brace(self):
        result = extract_field_paths("{ field } }")
        assert "field" in result

    def test_bare_spread(self):
        """graphql-core: parse('...')"""
        result = extract_field_paths("...")
        assert isinstance(result, list)

    def test_spread_at_top_level(self):
        result = extract_field_paths("{ ... }")
        assert isinstance(result, list)

    def test_double_colon(self):
        result = extract_field_paths("{ a :: b }")
        assert isinstance(result, list)

    def test_empty_argument_list(self):
        result = extract_field_paths("{ field() { id } }")
        assert "field" in result
        assert "field.id" in result

    def test_unbalanced_parens_in_arguments(self):
        """Missing closing paren — should not crash."""
        result = extract_field_paths("{ field(arg: 1 { id } }")
        assert isinstance(result, list)

    def test_unbalanced_braces_in_arguments(self):
        """Unbalanced braces in argument value."""
        result = extract_field_paths("{ field(arg: {a: 1) { id } }")
        assert isinstance(result, list)

    def test_garbage_after_selection_set(self):
        result = extract_field_paths("{ field } garbage here")
        assert "field" in result

    def test_number_as_field_name(self):
        """Numbers can't be field names — should skip gracefully."""
        result = extract_field_paths("{ 123 field }")
        assert "field" in result

    def test_at_sign_without_name(self):
        result = extract_field_paths("{ field @ { id } }")
        assert isinstance(result, list)

    def test_nested_unbalanced_braces(self):
        result = extract_field_paths("{ field { id }")
        assert isinstance(result, list)

    def test_completely_empty(self):
        assert extract_field_paths("") == []

    def test_only_whitespace_and_comments(self):
        assert extract_field_paths("   # just a comment\n   ") == []

    def test_operation_keyword_only(self):
        assert extract_field_paths("query") == []
        assert extract_field_paths("mutation") == []
        assert extract_field_paths("subscription") == []

    def test_unicode_field_names(self):
        """Non-ASCII identifiers are not valid GraphQL names — skip."""
        result = extract_field_paths("{ café }")
        # 'caf' is valid (alpha), 'é' is not — parser reads 'caf', skips 'é'
        assert isinstance(result, list)

    def test_null_bytes(self):
        """Null bytes in input must not crash."""
        result = extract_field_paths("{ field\x00 { id } }")
        assert isinstance(result, list)

    def test_long_run_of_unknown_chars_no_stack_overflow(self):
        """Many unknown characters must not cause stack overflow."""
        query = "{ field " + "!" * 10000 + " { id } }"
        result = extract_field_paths(query)
        assert "field" in result

    def test_non_string_input(self):
        """Non-string input returns empty list."""
        assert extract_field_paths(123) == []  # type: ignore[arg-type]
        assert extract_field_paths(b"{ field }") == []  # type: ignore[arg-type]

    def test_deep_nesting_recursion_error(self):
        """500 levels of nesting would hit Python recursion limit.

        Must return [] (fail-closed), not crash.
        """
        depth = 500
        query = "{ " + "a { " * depth + "x" + " }" * depth + " }"
        result = extract_field_paths(query)
        assert result == []

    def test_bare_quote_in_selection_set(self):
        """Bare " in selection set is skipped as unknown char."""
        result = extract_field_paths('{ "fake field }')
        # " is skipped, "fake" and "field" are extracted as field names
        assert "fake" in result
        assert "field" in result

    def test_single_dot(self):
        """Single dot is not a spread — skipped as unknown char."""
        result = extract_field_paths("{ field . other }")
        assert "field" in result
        assert "other" in result

    def test_double_dot(self):
        """Two dots are not a spread — each skipped as unknown char."""
        result = extract_field_paths("{ field .. other }")
        assert "field" in result
        assert "other" in result

    def test_only_named_spreads(self):
        """Selection set with only named spreads — no fields extracted."""
        assert extract_field_paths("{ ...A ...B ...C }") == []

    def test_alias_missing_field_name(self):
        """``{ a: }`` — alias with no field name falls back to alias name."""
        result = extract_field_paths("{ a: }")
        assert result == ["a"]

    def test_only_comment_in_selection_set(self):
        """Selection set containing only a comment — no fields."""
        assert extract_field_paths("{ # just a comment\n }") == []

    def test_spread_followed_by_colon(self):
        """``{ ...: field }`` — spread then colon is unusual but must not crash."""
        result = extract_field_paths("{ ...: field }")
        assert isinstance(result, list)

    def test_bom_inside_field_name(self):
        """BOM inside a field name splits it into two names."""
        result = extract_field_paths("{ fie\ufeffld }")
        # BOM is treated as whitespace by _skip_ignored
        assert "fie" in result
        assert "ld" in result

    def test_large_query_performance(self):
        """10k fields should parse without issue."""
        fields = " ".join(f"f{i}" for i in range(10000))
        result = extract_field_paths("{ " + fields + " }")
        assert len(result) == 10000


# =========================================================================
# CCN (Client-Controlled Nullability) — experimental syntax
# graphql-core supports `!`, `?`, `[!]`, `[]!` on fields.
# Our parser doesn't know these tokens — verify graceful handling.
# =========================================================================


class TestClientControlledNullability:
    """graphql-core CCN syntax: ``field!``, ``field?``, ``field[!]``.

    Our lexer doesn't produce tokens for ``!``, ``?``, or ``[]``.
    These characters are skipped by the lexer's ``next_token`` fallback.
    The important thing is: we extract the field name and don't crash.
    """

    def test_required_field(self):
        """``{ requiredField! }``"""
        result = extract_field_paths("{ requiredField! }")
        assert "requiredField" in result

    def test_optional_field(self):
        """``{ optionalField? }``"""
        result = extract_field_paths("{ optionalField? }")
        assert "optionalField" in result

    def test_required_field_with_alias(self):
        """``{ requiredField: field! }``"""
        result = extract_field_paths("{ requiredField: field! }")
        assert "field" in result

    def test_optional_field_with_alias(self):
        """``{ requiredField: field? }``"""
        result = extract_field_paths("{ requiredField: field? }")
        assert "field" in result

    def test_required_list_elements(self):
        """``{ field[!] }``"""
        result = extract_field_paths("{ field[!] }")
        assert "field" in result

    def test_optional_list_elements(self):
        """``{ field[?] }``"""
        result = extract_field_paths("{ field[?] }")
        assert "field" in result

    def test_required_list(self):
        """``{ field[]! }``"""
        result = extract_field_paths("{ field[]! }")
        assert "field" in result

    def test_optional_list(self):
        """``{ field[]? }``"""
        result = extract_field_paths("{ field[]? }")
        assert "field" in result

    def test_mixed_list_designators(self):
        """``{ field[[[?]!]]! }``"""
        result = extract_field_paths("{ field[[[?]!]]! }")
        assert "field" in result

    def test_ccn_with_selection_set(self):
        """``{ requiredSelectionSet(first: 10)! @directive { field } }``"""
        result = extract_field_paths("{ requiredSelectionSet(first: 10)! @directive { field } }")
        assert "requiredSelectionSet" in result

    def test_ccn_does_not_crash_on_multiple_designators(self):
        """``{ optionalField?! }`` — invalid but must not crash."""
        result = extract_field_paths("{ optionalField?! }")
        assert isinstance(result, list)

    def test_ccn_does_not_crash_on_reversed_designators(self):
        """``{ optionalField!? }`` — invalid but must not crash."""
        result = extract_field_paths("{ optionalField!? }")
        assert isinstance(result, list)

    def test_ccn_fields_with_siblings(self):
        """CCN-annotated fields must not eat sibling fields."""
        result = extract_field_paths("{ field1! field2? field3 }")
        assert "field1" in result
        assert "field2" in result
        assert "field3" in result

    def test_ccn_in_nested_selection(self):
        """CCN inside a nested selection set."""
        result = extract_field_paths("{ parent { child! sibling } }")
        assert "parent.child" in result
        assert "parent.sibling" in result


# =========================================================================
# graphql-core: keywords in ALL positions
# (the full pattern from `allows_non_keywords_anywhere_a_name_is_allowed`)
# =========================================================================


class TestKeywordsEveryPosition:
    """graphql-core tests keywords as operation name, fragment name,
    type name, field name, argument name, and directive name.

    We only extract field paths, so we verify the field extraction
    is correct regardless of keyword placement.
    """

    NON_ON_KEYWORDS: ClassVar[list[str]] = [
        "fragment",
        "query",
        "mutation",
        "subscription",
        "true",
        "false",
    ]

    @pytest.mark.parametrize("kw", NON_ON_KEYWORDS)
    def test_keyword_as_operation_name_and_field(self, kw: str):
        """``query {kw} { {kw} }`` — keyword as both operation name and field."""
        result = extract_field_paths(f"query {kw} {{ {kw} }}")
        assert result == [kw]

    @pytest.mark.parametrize("kw", NON_ON_KEYWORDS)
    def test_keyword_as_field_with_keyword_argument(self, kw: str):
        """``{{ {kw}({kw}: ${kw}) }}`` — keyword as field, arg name, and var."""
        result = extract_field_paths(f"{{ {kw}({kw}: ${kw}) }}")
        assert result == [kw]

    @pytest.mark.parametrize("kw", NON_ON_KEYWORDS)
    def test_keyword_as_directive_name(self, kw: str):
        """``{{ field @{kw}({kw}: {kw}) }}``"""
        result = extract_field_paths(f"{{ field @{kw}({kw}: {kw}) }}")
        assert result == ["field"]

    @pytest.mark.parametrize("kw", NON_ON_KEYWORDS)
    def test_keyword_as_inline_fragment_type(self, kw: str):
        """``{{ ... on {kw} {{ field }} }}``"""
        result = extract_field_paths(f"{{ ... on {kw} {{ field }} }}")
        assert "field" in result

    def test_on_as_operation_name(self):
        """``query on { field }`` — ``on`` as operation name."""
        result = extract_field_paths("query on { field }")
        assert result == ["field"]

    def test_on_as_field_with_arg(self):
        """``{ on(on: $on) }``"""
        result = extract_field_paths("{ on(on: $on) }")
        assert result == ["on"]

    def test_on_as_directive_name(self):
        """``{ field @on(on: on) }``"""
        result = extract_field_paths("{ field @on(on: on) }")
        assert result == ["field"]


# =========================================================================
# graphql-core: fragment definitions in document
# =========================================================================


class TestFragmentDefinitions:
    """Our parser only parses the first operation. Fragment definitions
    that follow should not interfere or crash.
    """

    def test_fragment_definition_after_query(self):
        """``{ ...a } fragment a on Type { field }``"""
        query = "{ ...a } fragment a on Type { field }"
        result = extract_field_paths(query)
        # We only parse the first operation { ...a }
        # ...a is a named spread (skipped), no fields extracted from it
        # "fragment" after "}" is not parsed
        assert isinstance(result, list)

    def test_fragment_definition_does_not_leak_fields(self):
        """Fields in fragment definitions must not appear in results."""
        query = """\
query { viewer { login } }

fragment UserFields on User {
  name
  email
  secretField
}
"""
        result = extract_field_paths(query)
        assert result == ["viewer", "viewer.login"]
        assert "name" not in result
        assert "email" not in result
        assert "secretField" not in result

    def test_multiple_fragment_definitions(self):
        query = """\
query { viewer { ...A ...B login } }

fragment A on User { name }
fragment B on User { email }
"""
        result = extract_field_paths(query)
        assert "viewer" in result
        assert "viewer.login" in result
        # Fragment contents not resolved
        assert "name" not in result
        assert "email" not in result

    def test_fragment_with_complex_arguments(self):
        """graphql-core kitchen sink fragment with block string argument."""
        query = """\
{ viewer { ...frag } }

fragment frag on Friend {
  foo(size: $size, bar: $b, obj: {key: "value", block: \"""

      block string uses \\\"\"\"

  \"""})
}
"""
        result = extract_field_paths(query)
        assert result == ["viewer"]
        assert "foo" not in result


# =========================================================================
# graphql-core: complex argument values
# =========================================================================


class TestComplexArguments:
    """Complex argument value patterns from graphql-core tests."""

    def test_nested_object_with_variable(self):
        """``{ field(complex: { a: { b: [ $var ] } }) }``"""
        result = extract_field_paths("{ field(complex: { a: { b: [ $var ] } }) }")
        assert result == ["field"]

    def test_variable_default_with_nested_object(self):
        """``query Foo($x: Complex = { a: { b: [ $var ] } }) { field }``"""
        result = extract_field_paths("query Foo($x: Complex = { a: { b: [ $var ] } }) { field }")
        assert result == ["field"]

    def test_list_argument(self):
        """``{ node(id: [123, 456]) { id } }``"""
        result = extract_field_paths("{ node(id: [123, 456]) { id } }")
        assert result == ["node", "node.id"]

    def test_boolean_and_null_arguments(self):
        """``{ unnamed(truthy: true, falsy: false, nullish: null) }``"""
        result = extract_field_paths("{ unnamed(truthy: true, falsy: false, nullish: null) }")
        assert result == ["unnamed"]

    def test_enum_argument_values(self):
        result = extract_field_paths("{ field(state: ACTIVE, sort: CREATED_AT, dir: DESC) }")
        assert result == ["field"]

    def test_negative_number_argument(self):
        result = extract_field_paths("{ field(offset: -10) { id } }")
        assert result == ["field", "field.id"]

    def test_float_argument(self):
        result = extract_field_paths("{ field(rate: 4.5) { id } }")
        assert result == ["field", "field.id"]

    def test_scientific_notation_argument(self):
        result = extract_field_paths("{ field(val: 123e4) { id } }")
        assert result == ["field", "field.id"]

    def test_multiple_object_arguments(self):
        """Multiple object-typed arguments."""
        result = extract_field_paths('{ field(a: {x: 1}, b: {y: "two"}, c: {z: true}) { id } }')
        assert result == ["field", "field.id"]


# =========================================================================
# graphql-core: multi-byte character tests
# =========================================================================


class TestMultiByteCharacters:
    """graphql-core: multi-byte character in comments and arguments."""

    def test_multi_byte_in_comment(self):
        """graphql-core: ``# This comment has a \\u0a0a multi-byte character.``"""
        query = "# This comment has a \u0a0a multi-byte character.\n{ field }"
        result = extract_field_paths(query)
        assert result == ["field"]

    def test_multi_byte_in_string_argument(self):
        """graphql-core: ``field(arg: "Has a \\u0a0a multi-byte character.")``"""
        query = '{ field(arg: "Has a \u0a0a multi-byte character.") }'
        result = extract_field_paths(query)
        assert result == ["field"]

    def test_emoji_in_comment(self):
        query = "# Comment \U0001f600\n{ field }"
        result = extract_field_paths(query)
        assert result == ["field"]

    def test_emoji_in_string_argument(self):
        query = '{ field(val: "\U0001f600") }'
        result = extract_field_paths(query)
        assert result == ["field"]


# =========================================================================
# Remaining graphql-core parser tests not yet covered
# =========================================================================


class TestGraphQLCoreRemainingParserTests:
    """graphql-core test_parser.py cases not covered by other test classes."""

    def test_fragment_missing_on_keyword(self):
        """graphql-core: ``{ ...MissingOn } fragment MissingOn Type``

        Invalid GraphQL (fragment definition missing ``on``).
        We only parse the first operation ``{ ...MissingOn }``.
        """
        query = "{ ...MissingOn }\nfragment MissingOn Type"
        result = extract_field_paths(query)
        # ...MissingOn is a named spread — skipped, no fields
        assert isinstance(result, list)
        assert "MissingOn" not in result

    def test_field_with_empty_object_value(self):
        """graphql-core: ``{ field: {} }``

        Invalid GraphQL (``{}`` as field value). Our parser sees
        ``field`` as alias, ``:`` as alias separator, then ``{`` ``}``
        which it tries to parse as a name — no name found, skips.
        """
        result = extract_field_paths("{ field: {} }")
        assert isinstance(result, list)

    def test_invalid_operation_keyword(self):
        """graphql-core: ``notAnOperation Foo { field }``

        Not a valid operation keyword. Our parser treats ``notAnOperation``
        as operation keyword (skips it), ``Foo`` as operation name, then
        parses ``{ field }``.
        """
        result = extract_field_paths("notAnOperation Foo { field }")
        assert isinstance(result, list)

    def test_empty_string_as_field(self):
        r"""graphql-core: ``{ ""``

        Incomplete query with empty string. Must not crash.
        """
        result = extract_field_paths('{ ""')
        assert isinstance(result, list)

    def test_fragment_named_on_is_invalid(self):
        """graphql-core: ``fragment on on on { on }``

        Invalid — ``on`` cannot be a fragment name. Our parser doesn't
        parse fragment definitions, so this is just garbage after the
        first operation (if any). Must not crash.
        """
        result = extract_field_paths("fragment on on on { on }")
        assert isinstance(result, list)

    def test_spread_of_on(self):
        """graphql-core: ``{ ...on }``

        ``...on`` is parsed as start of inline fragment ``... on TypeName``.
        ``}`` is not a valid type name, so parsing fails gracefully.
        """
        result = extract_field_paths("{ ...on }")
        assert isinstance(result, list)

    def test_legacy_fragment_variables(self):
        """graphql-core: ``fragment a($v: Boolean = false) on t { f(v: $v) }``

        Fragment definition with variables (legacy/experimental).
        Our parser doesn't parse fragment definitions — this should
        not produce any fields (no executable operation).
        """
        result = extract_field_paths("fragment a($v: Boolean = false) on t { f(v: $v) }")
        # "fragment" is not query/mutation/subscription, so _skip_operation_header
        # treats it as unknown and looks for '{'. It may find the fragment body's '{'.
        assert isinstance(result, list)

    def test_ccn_unbalanced_brackets(self):
        """graphql-core: ``{ field[[] }``, ``{ field[]] }``, ``{ field] }``, ``{ field[ }``"""
        for query in ("{ field[[] }", "{ field[]] }", "{ field] }", "{ field[ }"):
            result = extract_field_paths(query)
            assert isinstance(result, list), f"Crashed on: {query}"

    def test_ccn_assorted_invalid_designators(self):
        """graphql-core: ``{ field[][] }``, ``{ field[!!] }``, ``{ field[]?! }``"""
        for query in ("{ field[][] }", "{ field[!!] }", "{ field[]?! }"):
            result = extract_field_paths(query)
            assert isinstance(result, list), f"Crashed on: {query}"

    def test_ccn_designator_on_query(self):
        """graphql-core: ``query? { field }``"""
        result = extract_field_paths("query? { field }")
        assert isinstance(result, list)

    def test_ccn_bang_on_alias_left(self):
        """graphql-core: ``{ requiredField!: field }``"""
        result = extract_field_paths("{ requiredField!: field }")
        assert isinstance(result, list)

    def test_ccn_question_on_alias_left(self):
        """graphql-core: ``{ requiredField?: field }``"""
        result = extract_field_paths("{ requiredField?: field }")
        assert isinstance(result, list)

    def test_ccn_bang_on_both_sides(self):
        """graphql-core: ``{ requiredField!: field! }``"""
        result = extract_field_paths("{ requiredField!: field! }")
        assert isinstance(result, list)

    def test_ccn_question_on_both_sides(self):
        """graphql-core: ``{ requiredField?: field? }``"""
        result = extract_field_paths("{ requiredField?: field? }")
        assert isinstance(result, list)
