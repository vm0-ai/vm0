use std::io;
#[cfg(any(test, not(any(debug_assertions, feature = "test-support"))))]
use std::path::PathBuf;
use std::process::Command;
#[cfg(not(any(debug_assertions, feature = "test-support")))]
use std::sync::OnceLock;

#[cfg(not(any(debug_assertions, feature = "test-support")))]
const SANDBOX_USER: &str = "user";
#[cfg(not(any(debug_assertions, feature = "test-support")))]
static SANDBOX_USER_CREDENTIALS: OnceLock<UserCredentials> = OnceLock::new();

#[cfg(any(test, not(any(debug_assertions, feature = "test-support"))))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UserCredentials {
    username: String,
    uid: u32,
    gid: u32,
    home: PathBuf,
    groups: Vec<u32>,
}

enum TargetIdentity {
    Current,
    #[cfg(not(any(debug_assertions, feature = "test-support")))]
    User(UserCredentials),
}

pub(crate) fn apply_write_file_identity(command: &mut Command, sudo: bool) -> io::Result<()> {
    #[cfg(any(debug_assertions, feature = "test-support"))]
    let _ = command;
    match target_identity(sudo)? {
        TargetIdentity::Current => Ok(()),
        #[cfg(not(any(debug_assertions, feature = "test-support")))]
        TargetIdentity::User(credentials) => apply_credentials(command, credentials),
    }
}

fn target_identity(sudo: bool) -> io::Result<TargetIdentity> {
    if sudo {
        return Ok(TargetIdentity::Current);
    }

    #[cfg(any(debug_assertions, feature = "test-support"))]
    {
        // Local vsock tests run without the production rootfs user account.
        // Production release builds below resolve and drop to the sandbox user.
        Ok(TargetIdentity::Current)
    }

    #[cfg(not(any(debug_assertions, feature = "test-support")))]
    {
        cached_system_user_credentials()
            .map(|credentials| TargetIdentity::User(credentials.clone()))
    }
}

#[cfg(not(any(debug_assertions, feature = "test-support")))]
fn apply_credentials(command: &mut Command, credentials: UserCredentials) -> io::Result<()> {
    command
        .current_dir(&credentials.home)
        .env("HOME", &credentials.home)
        .env("USER", &credentials.username)
        .env("LOGNAME", &credentials.username);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        let uid = credentials.uid as libc::uid_t;
        let gid = credentials.gid as libc::gid_t;
        let groups: Vec<libc::gid_t> = credentials
            .groups
            .into_iter()
            .map(|group| group as libc::gid_t)
            .collect();

        // SAFETY: The closure only calls async-signal-safe credential syscalls
        // in the child immediately before exec. It does not allocate or touch
        // shared Rust state after fork.
        unsafe {
            command.pre_exec(move || {
                if !groups.is_empty() && libc::setgroups(groups.len(), groups.as_ptr()) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::setgid(gid) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::setuid(uid) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    #[cfg(not(unix))]
    {
        let _ = command;
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "write_file user credential drop requires Unix",
        ));
    }

    Ok(())
}

#[cfg(not(any(debug_assertions, feature = "test-support")))]
fn system_user_credentials(username: &str) -> io::Result<UserCredentials> {
    let passwd = std::fs::read_to_string("/etc/passwd")?;
    let group = std::fs::read_to_string("/etc/group")?;
    parse_user_credentials(&passwd, &group, username)
}

#[cfg(not(any(debug_assertions, feature = "test-support")))]
fn cached_system_user_credentials() -> io::Result<&'static UserCredentials> {
    if let Some(credentials) = SANDBOX_USER_CREDENTIALS.get() {
        return Ok(credentials);
    }

    let credentials = system_user_credentials(SANDBOX_USER)?;
    let _ = SANDBOX_USER_CREDENTIALS.set(credentials);
    SANDBOX_USER_CREDENTIALS
        .get()
        .ok_or_else(|| io::Error::other("sandbox user credential cache unavailable"))
}

#[cfg(any(test, not(any(debug_assertions, feature = "test-support"))))]
fn parse_user_credentials(
    passwd: &str,
    group: &str,
    username: &str,
) -> io::Result<UserCredentials> {
    let mut credentials = None;

    for line in passwd.lines() {
        let Some(candidate) = parse_passwd_line(line, username)? else {
            continue;
        };
        credentials = Some(candidate);
        break;
    }

    let mut credentials = credentials.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("sandbox user {username:?} not found in /etc/passwd"),
        )
    })?;
    credentials.groups = parse_supplementary_groups(group, username, credentials.gid)?;
    Ok(credentials)
}

#[cfg(any(test, not(any(debug_assertions, feature = "test-support"))))]
fn parse_passwd_line(line: &str, username: &str) -> io::Result<Option<UserCredentials>> {
    if line.trim().is_empty() || line.starts_with('#') {
        return Ok(None);
    }

    let mut fields = line.split(':');
    let name = fields.next().unwrap_or_default();
    if name != username {
        return Ok(None);
    }
    let _passwd = fields.next();
    let uid = parse_required_u32(fields.next(), "uid")?;
    let gid = parse_required_u32(fields.next(), "gid")?;
    let _gecos = fields.next();
    let home = fields.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("passwd entry for {username:?} missing home"),
        )
    })?;

    Ok(Some(UserCredentials {
        username: name.to_string(),
        uid,
        gid,
        home: PathBuf::from(home),
        groups: Vec::new(),
    }))
}

#[cfg(any(test, not(any(debug_assertions, feature = "test-support"))))]
fn parse_supplementary_groups(
    group: &str,
    username: &str,
    primary_gid: u32,
) -> io::Result<Vec<u32>> {
    let mut groups = vec![primary_gid];

    for line in group.lines() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }

        let mut fields = line.split(':');
        let _name = fields.next();
        let _passwd = fields.next();
        let gid = parse_required_u32(fields.next(), "group gid")?;
        let members = fields.next().unwrap_or_default();
        if gid == primary_gid || members.split(',').any(|member| member == username) {
            groups.push(gid);
        }
    }

    groups.sort_unstable();
    groups.dedup();
    Ok(groups)
}

#[cfg(any(test, not(any(debug_assertions, feature = "test-support"))))]
fn parse_required_u32(value: Option<&str>, field: &str) -> io::Result<u32> {
    let value = value.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, format!("missing {field} field"))
    })?;
    value.parse::<u32>().map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid {field} {value:?}: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_user_credentials_includes_primary_and_supplementary_groups() {
        let passwd = "root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000::/home/user:/bin/bash\n";
        let group = "user:x:1000:\nsudo:x:27:user\npostgres:x:113:user,other\n";

        let credentials = parse_user_credentials(passwd, group, "user").unwrap();

        assert_eq!(credentials.uid, 1000);
        assert_eq!(credentials.gid, 1000);
        assert_eq!(credentials.home, PathBuf::from("/home/user"));
        assert_eq!(credentials.groups, vec![27, 113, 1000]);
    }

    #[test]
    fn parse_user_credentials_fails_when_user_missing() {
        let err =
            parse_user_credentials("root:x:0:0:root:/root:/bin/bash\n", "", "user").unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn parse_user_credentials_fails_on_invalid_uid() {
        let err =
            parse_user_credentials("user:x:not-a-uid:1000::/home/user:/bin/bash\n", "", "user")
                .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
