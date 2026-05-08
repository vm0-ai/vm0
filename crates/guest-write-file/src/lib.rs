//! Direct guest file writer used by vsock-guest.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::PathBuf;

#[derive(Debug, Eq, PartialEq)]
struct Args {
    append: bool,
    create_parents: bool,
    path: PathBuf,
}

fn parse_args<I>(args: I) -> Result<Args, String>
where
    I: IntoIterator<Item = String>,
{
    let mut append = false;
    let mut create_parents = false;
    let mut path = None;
    let mut positional_only = false;

    for arg in args {
        if !positional_only {
            match arg.as_str() {
                "--append" => {
                    append = true;
                    continue;
                }
                "--create-parents" => {
                    create_parents = true;
                    continue;
                }
                "--" => {
                    positional_only = true;
                    continue;
                }
                flag if flag.starts_with('-') => {
                    return Err(format!("unknown argument: {flag}"));
                }
                _ => {}
            }
        }

        if path.replace(PathBuf::from(&arg)).is_some() {
            return Err("expected exactly one path".to_string());
        }
    }

    let path = path.ok_or_else(|| "missing path".to_string())?;
    Ok(Args {
        append,
        create_parents,
        path,
    })
}

fn run(args: Args, mut stdin: impl Read) -> io::Result<()> {
    if args.create_parents
        && let Some(parent) = args.path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(args.append)
        .truncate(!args.append)
        .open(&args.path)?;

    io::copy(&mut stdin, &mut file)?;
    file.flush()
}

pub fn run_cli<I>(args: I, stdin: impl Read, mut stderr: impl Write) -> i32
where
    I: IntoIterator<Item = String>,
{
    let args = match parse_args(args) {
        Ok(args) => args,
        Err(e) => {
            let _ = writeln!(stderr, "guest-write-file: {e}");
            let _ = writeln!(
                stderr,
                "usage: guest-write-file [--append] [--create-parents] <path>"
            );
            return 2;
        }
    };

    if let Err(e) = run(args, stdin) {
        let _ = writeln!(stderr, "guest-write-file: {e}");
        return 1;
    }

    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_create_parents() {
        let args =
            parse_args(["--create-parents".to_string(), "/tmp/out.txt".to_string()]).unwrap();

        assert_eq!(
            args,
            Args {
                append: false,
                create_parents: true,
                path: PathBuf::from("/tmp/out.txt"),
            }
        );
    }

    #[test]
    fn parse_append_after_separator_path_starting_with_dash() {
        let args = parse_args([
            "--append".to_string(),
            "--".to_string(),
            "-literal".to_string(),
        ])
        .unwrap();

        assert_eq!(
            args,
            Args {
                append: true,
                create_parents: false,
                path: PathBuf::from("-literal"),
            }
        );
    }

    #[test]
    fn rejects_extra_path() {
        let err = parse_args(["/tmp/a".to_string(), "/tmp/b".to_string()]).unwrap_err();

        assert!(err.contains("exactly one path"));
    }

    #[test]
    fn rejects_unknown_flag() {
        let err = parse_args(["--unknown".to_string(), "/tmp/a".to_string()]).unwrap_err();

        assert!(err.contains("unknown argument"));
    }
}
