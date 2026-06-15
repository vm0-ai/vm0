use std::io;

fn main() {
    let code = guest_write_file::run_cli(
        std::env::args().skip(1),
        io::stdin().lock(),
        io::stderr().lock(),
    );
    std::process::exit(code);
}
