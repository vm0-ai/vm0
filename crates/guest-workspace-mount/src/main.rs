//! Fixed privileged workspace mount helper. No caller-selected arguments.

fn main() {
    if std::env::args_os().len() != 1 {
        eprintln!("workspace mount helper accepts no arguments");
        std::process::exit(64);
    }
    if let Err(error) = guest_workspace_mount::mount_workspace_drive() {
        eprintln!("workspace mount failed: {error}");
        std::process::exit(1);
    }
}
