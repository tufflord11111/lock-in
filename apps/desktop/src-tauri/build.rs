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
  println!("cargo:rerun-if-changed=capabilities");
  tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern(capabilities))
    .expect("failed to run tauri-build");
}
