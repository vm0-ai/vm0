/// Log a message to stderr
pub fn log(level: &str, msg: &str) {
    eprintln!("[vsock-guest] [{level}] {msg}");
}
