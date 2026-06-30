//! Process-env config construction must coexist with legacy env accessors.
//!
//! This test lives in its own binary because `guest_agent::env` caches
//! environment values in process-wide `LazyLock`s.

#[test]
fn process_env_config_and_legacy_accessors_share_user_env_load() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let user_env_dir = runtime_dir.join("user-env");
    let user_env_path = user_env_dir.join("env.json");
    std::fs::create_dir_all(&user_env_dir).unwrap();
    std::fs::write(
        &user_env_path,
        r#"{"OPENAI_MODEL":"gpt-process-env","HOME":"/home/from-user-env"}"#,
    )
    .unwrap();

    unsafe {
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, "guest-config-process-env");
        std::env::set_var("HOME", "/home/from-process-env");
        std::env::set_var(guest_contracts::env::USER_ENV_FILE_ENV, &user_env_path);
        std::env::set_var(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        );
    }

    let config = guest_agent::env::GuestConfig::from_process_env().unwrap();

    assert_eq!(config.user_env["OPENAI_MODEL"], "gpt-process-env");
    assert_eq!(config.home_dir, "/home/from-user-env");
    assert!(!user_env_path.exists());
    assert!(!user_env_dir.exists());

    guest_agent::env::init_user_env().unwrap();
    assert_eq!(guest_agent::env::openai_model(), "gpt-process-env");
    assert_eq!(guest_agent::env::home_dir(), "/home/from-user-env");
}
