/// Join trailing positional args into a single prompt string. A leading `--`
/// separator (sometimes left in by clap when `trailing_var_arg` is set) is
/// dropped.
pub fn join_prompt(parts: &[String]) -> String {
    let mut iter = parts.iter().peekable();
    if let Some(first) = iter.peek()
        && first.as_str() == "--"
    {
        iter.next();
    }
    iter.cloned().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_prompt_joins_words() {
        let parts = vec!["hello".to_string(), "world".to_string()];
        assert_eq!(join_prompt(&parts), "hello world");
    }

    #[test]
    fn join_prompt_empty() {
        assert_eq!(join_prompt(&[]), "");
    }

    #[test]
    fn join_prompt_strips_leading_double_dash() {
        let parts = vec!["--".to_string(), "hi".to_string()];
        assert_eq!(join_prompt(&parts), "hi");
    }

    #[test]
    fn join_prompt_keeps_internal_double_dash() {
        let parts = vec!["foo".to_string(), "--".to_string(), "bar".to_string()];
        assert_eq!(join_prompt(&parts), "foo -- bar");
    }
}
