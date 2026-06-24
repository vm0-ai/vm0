//! POSIX shell argument quoting for executable command construction.
//!
//! This crate intentionally always quotes each argument. It is for command
//! strings that will be parsed by a POSIX shell, not for human-facing display
//! formatting.

/// Quote one argument as a POSIX shell word.
///
/// The returned string is always single-quoted. Embedded single quotes are
/// represented by ending the quoted string, emitting an escaped quote, and
/// reopening the quoted string.
pub fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_empty_string() {
        assert_eq!(quote_shell_arg(""), "''");
    }

    #[test]
    fn quotes_plain_text() {
        assert_eq!(quote_shell_arg("hello"), "'hello'");
    }

    #[test]
    fn quotes_whitespace() {
        assert_eq!(quote_shell_arg("hello world"), "'hello world'");
    }

    #[test]
    fn escapes_embedded_single_quotes() {
        assert_eq!(quote_shell_arg("it's"), "'it'\\''s'");
    }

    #[test]
    fn quotes_shell_metacharacters() {
        assert_eq!(quote_shell_arg("$HOME"), "'$HOME'");
    }

    #[test]
    fn quotes_safe_punctuation() {
        assert_eq!(quote_shell_arg("/tmp/a-b.c:+@%"), "'/tmp/a-b.c:+@%'");
    }

    #[test]
    fn quotes_assignment_like_words() {
        assert_eq!(quote_shell_arg("FOO=bar"), "'FOO=bar'");
    }

    #[test]
    fn quotes_shell_reserved_words() {
        assert_eq!(quote_shell_arg("if"), "'if'");
    }
}
