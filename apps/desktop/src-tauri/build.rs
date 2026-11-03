fn main() {
  // tauri-build validates EVERY capability file it parses against the plugins
  // actually compiled in. nsis/default.json grants updater:* and autostart:*,
  // which do not exist in the store build, so each build parses only its folder.
  // (tauri.store.conf.json also selects "store" at runtime; that alone cannot
  // stop nsis/default.json from failing validation here.)
  let capabilities = if std::env::var_os("CARGO_FEATURE_STORE").is_some() {
    "./capabilities/store/*.json"
  } else {
    "./capabilities/nsis/*.json"
  };
  println!("cargo:rerun-if-changed=capabilities");
  println!("cargo:rerun-if-changed=src/app_commands.in");
  // Listing the commands here is what gates them: with an app manifest, a
  // window can only call the commands its capability grants. Both capability
  // files name "main" alone, so no other window can reach the enforcer.
  let commands: &'static [&'static str] = include!("src/app_commands.in");
  let manifest = tauri_build::AppManifest::new().commands(commands);
  tauri_build::try_build(
    tauri_build::Attributes::new()
      .capabilities_path_pattern(capabilities)
      .app_manifest(manifest),
  )
  .expect("failed to run tauri-build");
}
