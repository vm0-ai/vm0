use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use proc_macro2::{Delimiter, TokenStream, TokenTree};

const CHECK_RUST_PATH_ATTRIBUTES: &str = "check-rust-path-attributes";

fn main() -> ExitCode {
    match run() {
        Ok(exit_code) => exit_code,
        Err(error) => {
            eprintln!("xtask: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<ExitCode, String> {
    let mut arguments = env::args_os().skip(1);

    match (arguments.next(), arguments.next()) {
        (Some(command), None) if command == CHECK_RUST_PATH_ATTRIBUTES => {
            check_rust_path_attributes()
        }
        _ => Err(format!("usage: cargo xtask {CHECK_RUST_PATH_ATTRIBUTES}")),
    }
}

fn check_rust_path_attributes() -> Result<ExitCode, String> {
    let repository_root = repository_root()?;
    let rust_files = rust_files(&repository_root)?;
    let mut violations = Vec::new();

    for relative_path in rust_files {
        let absolute_path = repository_root.join(&relative_path);
        if !absolute_path.exists() {
            continue;
        }

        let source = fs::read_to_string(&absolute_path)
            .map_err(|error| format!("failed to read {}: {error}", relative_path.display()))?;
        let tokens = source.parse::<TokenStream>().map_err(|error| {
            format!(
                "failed to tokenize {} while checking Rust attributes: {error}",
                relative_path.display()
            )
        })?;
        let mut lines = Vec::new();
        find_path_attributes(tokens, &mut lines);

        for line in lines {
            violations.push(format!("{}:{line}", relative_path.display()));
        }
    }

    if violations.is_empty() {
        return Ok(ExitCode::SUCCESS);
    }

    eprintln!("Rust #[path] attributes are forbidden. Use the native module file layout instead:");
    for violation in violations {
        eprintln!("{violation}");
    }

    Ok(ExitCode::FAILURE)
}

fn repository_root() -> Result<PathBuf, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|error| format!("failed to locate the Git repository: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "failed to locate the Git repository: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let root = String::from_utf8(output.stdout)
        .map_err(|error| format!("Git repository path is not UTF-8: {error}"))?;
    let root = root.trim();
    if root.is_empty() {
        return Err("Git returned an empty repository path".to_owned());
    }

    Ok(PathBuf::from(root))
}

fn rust_files(repository_root: &Path) -> Result<Vec<PathBuf>, String> {
    let output = Command::new("git")
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            "*.rs",
        ])
        .current_dir(repository_root)
        .output()
        .map_err(|error| format!("failed to list Rust files: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "failed to list Rust files: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let paths = String::from_utf8(output.stdout)
        .map_err(|error| format!("Git returned a non-UTF-8 Rust file path: {error}"))?;

    Ok(paths
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .collect())
}

fn find_path_attributes(tokens: TokenStream, lines: &mut Vec<usize>) {
    let tokens = tokens.into_iter().collect::<Vec<_>>();
    let mut index = 0;

    while let Some(token) = tokens.get(index) {
        if let TokenTree::Punct(hash) = token
            && hash.as_char() == '#'
        {
            let mut attribute_index = index + 1;
            if matches!(
                tokens.get(attribute_index),
                Some(TokenTree::Punct(punctuation)) if punctuation.as_char() == '!'
            ) {
                attribute_index += 1;
            }

            if let Some(TokenTree::Group(attribute)) = tokens.get(attribute_index)
                && attribute.delimiter() == Delimiter::Bracket
                && meta_contains_path_attribute(&attribute.stream().into_iter().collect::<Vec<_>>())
            {
                lines.push(hash.span().start().line);
            }
        }

        if let TokenTree::Group(group) = token {
            find_path_attributes(group.stream(), lines);
        }

        index += 1;
    }
}

fn meta_contains_path_attribute(tokens: &[TokenTree]) -> bool {
    let mut tokens = tokens.iter();
    let Some(TokenTree::Ident(name)) = tokens.next() else {
        return false;
    };
    let next = tokens.next();

    match name.to_string().as_str() {
        "path" => {
            matches!(next, Some(TokenTree::Punct(punctuation)) if punctuation.as_char() == '=')
        }
        "cfg_attr" => {
            let Some(TokenTree::Group(arguments)) = next else {
                return false;
            };
            arguments.delimiter() == Delimiter::Parenthesis
                && cfg_attr_contains_path_attribute(arguments.stream())
        }
        _ => false,
    }
}

fn cfg_attr_contains_path_attribute(arguments: TokenStream) -> bool {
    let mut segment = Vec::new();
    let mut condition_complete = false;

    for token in arguments {
        if matches!(&token, TokenTree::Punct(punctuation) if punctuation.as_char() == ',') {
            if condition_complete && meta_contains_path_attribute(&segment) {
                return true;
            }
            segment.clear();
            condition_complete = true;
        } else {
            segment.push(token);
        }
    }

    condition_complete && meta_contains_path_attribute(&segment)
}
