#[test]
fn guest_process_handles_require_explicit_ownership() {
    trybuild::TestCases::new().compile_fail("tests/ui/guest_process_handles_must_use.rs");
}
