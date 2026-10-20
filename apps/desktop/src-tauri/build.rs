fn main() {
  // tauri-build validates EVERY capability file it parses against the plugins
  // actually compiled in. default.json grants updater:* and autostart:*, which
  // do not exist in the store build, so each build parses only its own file.
  // (tauri.store.conf.json also selects "store" at runtime; that alone cannot
  // stop default.json from failing validation here.)
  let capabilities = if std::env::var_os("CARGO_FEATURE_STORE").is_some() {
    "./capabilities/store.json"
  } else {
    "./capabilities/default.json"
  };
  // Both are required. rerun-if-changed alone is not enough: switching
  // features does not touch capabilities/, so cargo reused the previous
  // variant's build-script output and the crate compiled against the WRONG
  // capability set — an NSIS build carrying the store ACL loses autostart and
  // updater at runtime, silently, with no build error.
  println!("cargo:rerun-if-changed=capabilities");
  println!("cargo:rerun-if-env-changed=CARGO_FEATURE_STORE");
  tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern(capabilities))
    .expect("failed to run tauri-build");
}
