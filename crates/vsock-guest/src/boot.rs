use std::io;

const BOOT_GENERATION_KEY: &str = "vm0.boot_generation=";

pub(crate) fn parse_boot_generation(cmdline: &str) -> Option<&str> {
    cmdline
        .split_ascii_whitespace()
        .find_map(|arg| arg.strip_prefix(BOOT_GENERATION_KEY))
        .filter(|value| !value.is_empty())
}

pub(crate) fn read_boot_generation() -> io::Result<Option<String>> {
    let cmdline = std::fs::read_to_string("/proc/cmdline")?;
    Ok(parse_boot_generation(&cmdline).map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_boot_generation_reads_vm0_arg() {
        assert_eq!(
            parse_boot_generation("console=ttyS0 root=/dev/vda vm0.boot_generation=boot-123 quiet"),
            Some("boot-123")
        );
    }

    #[test]
    fn parse_boot_generation_ignores_missing_or_empty_values() {
        assert_eq!(parse_boot_generation("console=ttyS0 root=/dev/vda"), None);
        assert_eq!(
            parse_boot_generation("console=ttyS0 vm0.boot_generation= root=/dev/vda"),
            None
        );
    }
}
