use super::*;

#[test]
fn scan_and_claim_skips_excluded_index_before_free_check() {
    fn panic_if_checked(_: u32) -> bool {
        panic!("excluded index should not be checked");
    }

    let dir = tempfile::tempdir().expect("tempdir");
    let exclude = HashSet::from([0]);

    let result = scan_and_claim_with(1, &exclude, dir.path(), panic_if_checked);

    assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
}

#[test]
fn scan_and_claim_skips_held_lock() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _held = claim(0, dir.path());
    let exclude = HashSet::new();

    let result = scan_and_claim_with(1, &exclude, dir.path(), always_free);

    assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
}

#[test]
fn scan_and_claim_skips_unopenable_lock_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir(dir.path().join("vm0-nbd-0.lock")).expect("create lock path dir");
    let exclude = HashSet::new();

    let result = scan_and_claim_with(1, &exclude, dir.path(), always_free);

    assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
}

#[test]
fn scan_and_claim_releases_lock_when_post_lock_recheck_fails() {
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    fn free_once(_: u32) -> bool {
        CALLS.fetch_add(1, Ordering::SeqCst) == 0
    }

    let dir = tempfile::tempdir().expect("tempdir");
    let exclude = HashSet::new();
    let result = scan_and_claim_with(1, &exclude, dir.path(), free_once);

    assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    assert!(claim(0, dir.path()).index() == 0);
    CALLS.store(0, Ordering::SeqCst);
}
