pub(crate) mod empty;
pub(crate) mod error;
pub(crate) mod exec_control;
pub(crate) mod exec_operation;
pub(crate) mod write_file;

fn truncate_utf8_to_u16_bytes(value: &str) -> (&[u8], u16) {
    let mut end = value.len().min(u16::MAX as usize);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    let (prefix, _) = value.split_at(end);
    (prefix.as_bytes(), end as u16)
}
