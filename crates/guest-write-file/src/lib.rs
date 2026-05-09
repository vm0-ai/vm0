//! Direct guest file writer used by vsock-guest.
//!
//! Writes use shell-like create/truncate/write semantics. A failed write may
//! leave an empty or partial target.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const BATCH_MAGIC: &[u8; 8] = b"VM0WFB1\n";

#[derive(Debug, Eq, PartialEq)]
struct Args {
    batch: bool,
    create_parents: bool,
    path: Option<PathBuf>,
}

fn parse_args<I>(args: I) -> Result<Args, String>
where
    I: IntoIterator<Item = String>,
{
    let mut batch = false;
    let mut create_parents = false;
    let mut path = None;
    let mut positional_only = false;

    for arg in args {
        if !positional_only {
            match arg.as_str() {
                "--batch" => {
                    batch = true;
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

    if batch && path.is_some() {
        return Err("--batch does not accept a path argument".to_string());
    }
    if !batch && path.is_none() {
        return Err("missing path".to_string());
    }

    Ok(Args {
        batch,
        create_parents,
        path,
    })
}

fn run(args: Args, mut stdin: impl Read) -> io::Result<()> {
    if args.batch {
        return run_batch(args.create_parents, stdin);
    }
    let path = args
        .path
        .as_ref()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing path"))?;
    write_file_from_reader(path, args.create_parents, &mut stdin, None)
}

fn run_batch(create_parents: bool, mut stdin: impl Read) -> io::Result<()> {
    let mut magic = [0u8; BATCH_MAGIC.len()];
    stdin.read_exact(&mut magic)?;
    if &magic != BATCH_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid batch magic",
        ));
    }
    let count = read_u32(&mut stdin)?;
    for _ in 0..count {
        let _file_index = read_u32(&mut stdin)?;
        let path_len = read_u16(&mut stdin)? as usize;
        let mut path = vec![0u8; path_len];
        stdin.read_exact(&mut path)?;
        let path = PathBuf::from(String::from_utf8(path).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-8 in batch path")
        })?);
        let content_len = read_u64(&mut stdin)?;
        write_file_from_reader(&path, create_parents, &mut stdin, Some(content_len))?;
    }
    Ok(())
}

fn read_u16(reader: &mut impl Read) -> io::Result<u16> {
    let mut buf = [0u8; 2];
    reader.read_exact(&mut buf)?;
    Ok(u16::from_be_bytes(buf))
}

fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf)?;
    Ok(u32::from_be_bytes(buf))
}

fn read_u64(reader: &mut impl Read) -> io::Result<u64> {
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf)?;
    Ok(u64::from_be_bytes(buf))
}

fn write_file_from_reader(
    path: &Path,
    create_parents: bool,
    input: &mut impl Read,
    exact_len: Option<u64>,
) -> io::Result<()> {
    if create_parents
        && let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }

    let mut file = open_output_file(path)?;
    match exact_len {
        Some(len) => copy_exact_len(input, &mut file, len)?,
        None => {
            io::copy(input, &mut file)?;
        }
    }
    file.flush()
}

fn copy_exact_len(input: &mut impl Read, output: &mut impl Write, len: u64) -> io::Result<()> {
    let mut remaining = len;
    let mut buf = [0u8; 64 * 1024];
    while remaining > 0 {
        let n = remaining.min(buf.len() as u64) as usize;
        let chunk = buf
            .get_mut(..n)
            .ok_or_else(|| io::Error::other("copy chunk length exceeds buffer"))?;
        input.read_exact(chunk)?;
        output.write_all(chunk)?;
        remaining -= n as u64;
    }
    Ok(())
}

fn open_output_file(path: &Path) -> io::Result<File> {
    let file = output_options().open(path)?;
    prepare_output_file(&file)?;
    Ok(file)
}

fn output_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
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
                "usage: guest-write-file [--create-parents] <path> | --batch [--create-parents]"
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

    fn batch_payload(files: &[(&Path, &[u8])]) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.extend_from_slice(BATCH_MAGIC);
        payload.extend_from_slice(&(files.len() as u32).to_be_bytes());
        for (index, (path, content)) in files.iter().enumerate() {
            let path = path.to_string_lossy();
            let path_bytes = path.as_bytes();
            payload.extend_from_slice(&(index as u32).to_be_bytes());
            payload.extend_from_slice(&(path_bytes.len() as u16).to_be_bytes());
            payload.extend_from_slice(path_bytes);
            payload.extend_from_slice(&(content.len() as u64).to_be_bytes());
            payload.extend_from_slice(content);
        }
        payload
    }

    #[test]
    fn parse_create_parents() {
        let args =
            parse_args(["--create-parents".to_string(), "/tmp/out.txt".to_string()]).unwrap();

        assert_eq!(
            args,
            Args {
                batch: false,
                create_parents: true,
                path: Some(PathBuf::from("/tmp/out.txt")),
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
    fn parse_batch_without_path() {
        let args = parse_args(["--batch".to_string(), "--create-parents".to_string()]).unwrap();

        assert_eq!(
            args,
            Args {
                batch: true,
                create_parents: true,
                path: None,
            }
        );
    }

    #[test]
    fn rejects_batch_with_path() {
        let err = parse_args(["--batch".to_string(), "/tmp/out".to_string()]).unwrap_err();

        assert!(err.contains("does not accept a path"));
    }

    #[test]
    fn batch_writes_multiple_files_with_parents() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("a.txt");
        let second = temp.path().join("nested").join("b.txt");
        let payload = batch_payload(&[(&first, b"one"), (&second, b"two")]);

        run(
            Args {
                batch: true,
                create_parents: true,
                path: None,
            },
            payload.as_slice(),
        )
        .unwrap();

        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        assert_eq!(std::fs::read(&second).unwrap(), b"two");
    }

    #[test]
    fn batch_writes_empty_file_with_parents() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("nested").join("empty.txt");
        let payload = batch_payload(&[(&target, b"")]);

        run(
            Args {
                batch: true,
                create_parents: true,
                path: None,
            },
            payload.as_slice(),
        )
        .unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"");
    }

    #[test]
    fn batch_truncated_content_preserves_write_file_truncate_semantics() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("out.txt");
        let mut payload = Vec::new();
        payload.extend_from_slice(BATCH_MAGIC);
        payload.extend_from_slice(&1u32.to_be_bytes());
        let path = target.to_string_lossy();
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.extend_from_slice(&(path.len() as u16).to_be_bytes());
        payload.extend_from_slice(path.as_bytes());
        payload.extend_from_slice(&10u64.to_be_bytes());
        payload.extend_from_slice(b"short");

        let err = run(
            Args {
                batch: true,
                create_parents: true,
                path: None,
            },
            payload.as_slice(),
        )
        .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"",
            "batch mode should match existing write_file truncate-before-write behavior"
        );
    }
}
