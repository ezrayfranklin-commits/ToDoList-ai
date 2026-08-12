// TodoList for AI — Tauri v2 backend shell.
// Per the project plan, the Rust layer stays thin: it only assembles
// official Tauri plugins (SQLite, notifications, shell, autostart, ...).
// All business logic lives in the frontend (React) layer.

use tauri::Manager;

#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "TodoList AI",
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// 只读读取用户本机 pi 的配置（~/.config/app/agent/settings.json + models.json），
/// 供应用「一键导入」使用。仅读取、绝不写入 pi 的任何文件（隔离原则）。
#[tauri::command]
fn read_app_config() -> Result<Option<String>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let base = format!("{home}/.pi/agent");
    let mut out = serde_json::Map::new();
    for name in ["settings.json", "models.json"] {
        let path = format!("{base}/{name}");
        if let Ok(s) = std::fs::read_to_string(&path) {
            out.insert(name.trim_end_matches(".json").to_string(), serde_json::Value::String(s));
        }
    }
    if out.is_empty() {
        Ok(None)
    } else {
        Ok(Some(serde_json::Value::Object(out).to_string()))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the main window when a second instance is launched.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:todolist.db", Default::default())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![app_info, read_app_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
