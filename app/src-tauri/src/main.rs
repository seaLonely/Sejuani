// Sejuani 桌面壳：启动时拉起本地后端，退出时回收子进程。
// shell 子进程直接用 std::process::Command，无需 tauri-plugin-shell。

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::Manager;

struct BackendProcess(Mutex<Option<Child>>);

/// 启动后端 API 服务（端口 7758）。
/// 优先使用项目本地 dist/index.js（dev 模式），
/// 找不到时 fallback 到 PATH 中的 sjn。
/// 均失败时不阻塞 App 启动——前端健康检查失败会展示「后端未连接」引导。
fn spawn_backend() -> Option<Child> {
    // dev 模式：CARGO_MANIFEST_DIR 在编译时指向 app/src-tauri/，
    // 项目根目录在两级之上。
    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()  // app/
        .and_then(|p| p.parent())  // project root
        .map(|p| p.to_path_buf());

    if let Some(root) = project_root {
        let entry = root.join("dist").join("index.js");
        if entry.exists() {
            match Command::new("node")
                .args([entry.to_string_lossy().as_ref(), "serve", "--port", "7758"])
                .current_dir(&root)
                .spawn()
            {
                Ok(child) => {
                    println!(
                        "[sejuani] backend spawned via node dist/index.js (pid {})",
                        child.id()
                    );
                    return Some(child);
                }
                Err(e) => {
                    eprintln!("[sejuani] node spawn failed: {e}, trying sjn in PATH...");
                }
            }
        }
    }

    // fallback：尝试全局 sjn
    match Command::new("sjn").args(["serve", "--port", "7758"]).spawn() {
        Ok(child) => {
            println!("[sejuani] backend spawned: sjn serve --port 7758 (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[sejuani] 未能启动后端：{e}");
            eprintln!("[sejuani] 请手动执行 `sjn serve --port 7758` 或确保 node 在 PATH 中");
            None
        }
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(BackendProcess(Mutex::new(spawn_backend())));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building sejuani app")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<BackendProcess>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                        println!("[sejuani] backend process killed");
                    }
                }
            }
        });
}
