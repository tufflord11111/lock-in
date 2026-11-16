// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Before anything can create a webview (1.3.1 H2).
  app_lib::scrub_webview2_env();
  app_lib::run();
}
