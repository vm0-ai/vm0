use std::borrow::Cow;

/// Join trailing positional args into a single prompt string. A leading `--`
/// separator (sometimes left in by clap when `trailing_var_arg` is set) is
/// dropped.
pub fn join_prompt(parts: &[String]) -> String {
    join_prompt_cow(parts).into_owned()
}

/// Join trailing positional args with the same separator handling as
/// `join_prompt`, but without allocating when no owned output is needed.
pub fn join_prompt_cow(parts: &[String]) -> Cow<'_, str> {
    let parts = match parts {
        [first, rest @ ..] if first.as_str() == "--" => rest,
        _ => parts,
    };

    match parts {
        [] => Cow::Borrowed(""),
        [single] => Cow::Borrowed(single.as_str()),
        _ => Cow::Owned(parts.join(" ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn join_prompt_joins_words() {
        let parts = parts(&["hello", "world"]);
        assert_eq!(join_prompt(&parts), "hello world");
    }

    #[test]
    fn join_prompt_cow_owns_joined_words() {
        let parts = parts(&["hello", "world"]);
        match join_prompt_cow(&parts) {
            Cow::Owned(prompt) => assert_eq!(prompt, "hello world"),
            Cow::Borrowed(prompt) => panic!("expected owned joined prompt, got {prompt:?}"),
        }
    }

    #[test]
    fn join_prompt_empty() {
        assert_eq!(join_prompt(&[]), "");
    }

    #[test]
    fn join_prompt_cow_borrows_empty_prompt() {
        assert!(matches!(join_prompt_cow(&[]), Cow::Borrowed("")));
    }

    #[test]
    fn join_prompt_cow_borrows_single_word() {
        let parts = parts(&["hello"]);
        assert!(matches!(join_prompt_cow(&parts), Cow::Borrowed("hello")));
    }

    #[test]
    fn join_prompt_strips_leading_double_dash() {
        let parts = parts(&["--", "hi"]);
        assert_eq!(join_prompt(&parts), "hi");
    }

    #[test]
    fn join_prompt_strips_only_double_dash_to_empty_prompt() {
        let parts = parts(&["--"]);
        assert_eq!(join_prompt(&parts), "");
        assert!(matches!(join_prompt_cow(&parts), Cow::Borrowed("")));
    }

    #[test]
    fn join_prompt_strips_only_one_leading_double_dash() {
        let parts = parts(&["--", "--"]);
        assert_eq!(join_prompt(&parts), "--");
        assert!(matches!(join_prompt_cow(&parts), Cow::Borrowed("--")));
    }

    #[test]
    fn join_prompt_keeps_internal_double_dash() {
        let parts = parts(&["foo", "--", "bar"]);
        assert_eq!(join_prompt(&parts), "foo -- bar");
    }

    #[test]
    fn join_prompt_preserves_empty_prompt_parts() {
        for (values, expected) in [
            (&["", "tail"][..], " tail"),
            (&["head", ""][..], "head "),
            (&["--", "", "tail"][..], " tail"),
            (&["", ""][..], " "),
        ] {
            let parts = parts(values);
            assert_eq!(join_prompt(&parts), expected);
        }
    }
}
