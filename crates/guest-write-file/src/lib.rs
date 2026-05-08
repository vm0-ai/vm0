//! Direct guest file writer used by vsock-guest.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

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
    if append && create_parents {
        return Err("--append and --create-parents cannot be used together".to_string());
    }

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

    let mut file = open_output_file(&args.path, args.append)?;

    io::copy(&mut stdin, &mut file)?;
    file.flush()
}

fn open_output_file(path: &Path, append: bool) -> io::Result<File> {
    let file = output_options(append).open(path)?;
    prepare_output_file(&file)?;
    Ok(file)
}

fn output_options(append: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.custom_flags(libc::O_NONBLOCK);
    }

    options
}

#[cfg(unix)]
fn prepare_output_file(file: &File) -> io::Result<()> {
    use std::os::unix::io::AsRawFd;

    let fd = file.as_raw_fd();
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to valid writable memory and `fd` comes from a
    // live File. On success, fstat initializes the whole struct.
    let result = unsafe { libc::fstat(fd, stat.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstat succeeded and initialized `stat`.
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "target is not a regular file",
        ));
    }

    // `O_NONBLOCK` is only used to keep opening FIFOs/special files from
    // hanging. Regular-file writes should keep normal blocking semantics.
    // SAFETY: `fd` comes from a live File and F_GETFL only reads descriptor
    // status flags.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_NONBLOCK != 0 {
        // SAFETY: `fd` comes from a live File. F_SETFL updates descriptor
        // status flags and leaves the open file description otherwise intact.
        let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
    }

    Ok(())
}

#[cfg(not(unix))]
fn prepare_output_file(_file: &File) -> io::Result<()> {
    Ok(())
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
                "usage: guest-write-file [--append | --create-parents] <path>"
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

    #[test]
    fn rejects_append_with_create_parents() {
        let err = parse_args([
            "--append".to_string(),
            "--create-parents".to_string(),
            "/tmp/a".to_string(),
        ])
        .unwrap_err();

        assert!(err.contains("cannot be used together"));
    }
}
