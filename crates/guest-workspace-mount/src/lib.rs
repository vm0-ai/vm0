//! Fixed guest workspace mounting without shell or repeated utility launches.
//!
//! The actual ext4 mount still uses the rootfs mount tool. The caller owns this
//! helper's process group, including that child, through timeout and disconnect.

use std::ffi::CString;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use nix::unistd::{Group, User};
use rustix::fs::{AtFlags, CWD, StatxFlags, statx};

const WORKSPACE_DIR: &str = "/home/user/workspace";
const WORKSPACE_DEVICE: &str = "/dev/vdb";
const MOUNTINFO_PATH: &str = "/proc/self/mountinfo";

/// Mount the fixed workspace device, or repair an already-matching mount.
///
/// User and group identities come from the rootfs account authority, matching
/// `chown -h user:user`. Failure never substitutes a guessed numeric identity.
pub fn mount_workspace_drive() -> io::Result<()> {
    let user = User::from_name("user")?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "workspace user unavailable"))?;
    let group = Group::from_name("user")?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "workspace group unavailable"))?;
    mount_at(
        Path::new(WORKSPACE_DIR),
        Path::new(WORKSPACE_DEVICE),
        Path::new(MOUNTINFO_PATH),
        user.uid.as_raw(),
        group.gid.as_raw(),
    )
}

fn mount_at(
    directory: &Path,
    device: &Path,
    mountinfo_path: &Path,
    uid: u32,
    gid: u32,
) -> io::Result<()> {
    reject_symlink_components(directory)?;
    let device_metadata = fs::metadata(device)?;
    if !device_metadata.file_type().is_block_device() {
        return Err(invalid("workspace device is not a block device"));
    }
    let workspace_device = (
        libc::major(device_metadata.rdev()),
        libc::minor(device_metadata.rdev()),
    );
    let target = match statx(
        CWD,
        directory,
        AtFlags::SYMLINK_NOFOLLOW | AtFlags::NO_AUTOMOUNT,
        StatxFlags::MNT_ID,
    ) {
        Ok(target) => {
            if target.stx_mask & StatxFlags::MNT_ID.bits() == 0 {
                return Err(invalid("workspace mount identity unavailable"));
            }
            Some(target)
        }
        Err(rustix::io::Errno::NOENT) => None,
        Err(error) => return Err(error.into()),
    };
    let mountinfo = fs::read(mountinfo_path)?;
    let mounts = parse_mountinfo(&mountinfo)?;
    if let Some(target) = target {
        // Mount IDs identify the visible mount even for bind or stacked mounts.
        // A matching device on a containing filesystem is not a mountpoint.
        let visible = mounts
            .iter()
            .find(|mount| mount.id == target.stx_mnt_id)
            .ok_or_else(|| invalid("visible workspace mount missing from mountinfo"))?;
        if visible.target == directory.as_os_str().as_bytes() {
            if visible.device != workspace_device
                || (target.stx_dev_major, target.stx_dev_minor) != workspace_device
            {
                return Err(invalid("refusing unrelated existing workspace mount"));
            }
            return repair_owner(directory, uid, gid);
        }
    }
    if mounts.iter().any(|mount| mount.device == workspace_device) {
        return Err(invalid("workspace device is already mounted elsewhere"));
    }

    fs::create_dir_all(directory)?;
    reject_symlink_components(directory)?;
    let status = Command::new("/usr/bin/mount")
        .args(["-t", "ext4", "--"])
        .arg(device)
        .arg(directory)
        .status()?;
    if !status.success() {
        return Err(io::Error::other(format!("ext4 mount failed: {status}")));
    }
    repair_owner(directory, uid, gid)
}

fn reject_symlink_components(directory: &Path) -> io::Result<()> {
    let mut current = PathBuf::new();
    for component in directory.components() {
        match component {
            Component::RootDir | Component::Normal(_) => current.push(component),
            _ => return Err(invalid("workspace path must be absolute and normalized")),
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(invalid("refusing symlink workspace path component"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    if !directory.is_absolute() {
        return Err(invalid("workspace path must be absolute and normalized"));
    }
    Ok(())
}

fn repair_owner(directory: &Path, uid: u32, gid: u32) -> io::Result<()> {
    let path = CString::new(directory.as_os_str().as_bytes())
        .map_err(|_| invalid("workspace path contains NUL"))?;
    // SAFETY: path is NUL-terminated; scalar IDs come from the account authority.
    // Do not follow a last-component symlink, matching the former chown -h.
    let result = unsafe {
        libc::fchownat(
            libc::AT_FDCWD,
            path.as_ptr(),
            uid,
            gid,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

struct Mount {
    id: u64,
    device: (u32, u32),
    target: Vec<u8>,
}

fn parse_mountinfo(input: &[u8]) -> io::Result<Vec<Mount>> {
    let mut mounts = Vec::new();
    for line in input
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let fields: Vec<_> = line.split(|byte| *byte == b' ').collect();
        let Some(separator) = fields.iter().position(|field| *field == b"-") else {
            return Err(invalid("invalid workspace mountinfo record"));
        };
        if separator < 6 || fields.len() != separator + 4 {
            return Err(invalid("invalid workspace mountinfo fields"));
        }
        let [id, _, device, _, target, ..] = fields.as_slice() else {
            return Err(invalid("invalid workspace mountinfo fields"));
        };
        let id = parse_number(id)?;
        let mut device = device.split(|byte| *byte == b':');
        let major = parse_number(device.next().unwrap_or_default())?;
        let minor = parse_number(device.next().unwrap_or_default())?;
        if device.next().is_some() {
            return Err(invalid("invalid workspace mountinfo device"));
        }
        mounts.push(Mount {
            id,
            device: (major, minor),
            target: decode_mount_path(target)?,
        });
    }
    if mounts.is_empty() {
        return Err(invalid("workspace mountinfo is empty"));
    }
    Ok(mounts)
}

fn parse_number<T: std::str::FromStr>(input: &[u8]) -> io::Result<T> {
    std::str::from_utf8(input)
        .ok()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| invalid("invalid workspace mountinfo number"))
}

fn decode_mount_path(input: &[u8]) -> io::Result<Vec<u8>> {
    let mut path = Vec::with_capacity(input.len());
    let mut index = 0;
    while let Some(&byte) = input.get(index) {
        if byte != b'\\' {
            path.push(byte);
            index += 1;
            continue;
        }
        let decoded = match input.get(index..index + 4) {
            Some(b"\\040") => b' ',
            Some(b"\\011") => b'\t',
            Some(b"\\012") => b'\n',
            Some(b"\\134") => b'\\',
            _ => return Err(invalid("invalid workspace mountinfo path escape")),
        };
        path.push(decoded);
        index += 4;
    }
    Ok(path)
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
