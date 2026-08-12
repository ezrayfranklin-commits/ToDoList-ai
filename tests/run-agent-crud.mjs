// 打包并运行 agent-crud 端到端测试.
// Node 环境没有 Tauri 插件, 通过 esbuild alias 把 @/lib/db / plugin-sql /
// plugin-http / plugin-notification 替换为 tests/shim 下的内存实现.
// 被测试的 buildAgentTools / runAgentLoop / calendar skill 均为真实源码.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const root = path.dirname(fileURLToPath(import.meta.url));
const shim = (name) => path.join(root, "shim", name);

// 从真实 app DB 读 ai.* settings, 注入环境变量给测试 (只读, 不污染).
const realDbPath = path.join(
  process.env.HOME ?? "",
  "Library/Application Support/com.todolistai.app/todolist.db",
);
try {
  if (fs.existsSync(realDbPath)) {
    const d = new DatabaseSync(realDbPath, { readOnly: true });
    const rows = d.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai.%'").all();
    d.close();
    for (const r of rows) {
      let v = String(r.value);
      try {
        v = JSON.parse(v);
      } catch {
        /* keep raw */
      }
      const envKey = "TEST_AI_" + String(r.key).replace("ai.", "").toUpperCase();
      process.env[envKey] = v;
    }
  }
} catch (e) {
  console.warn(`[warn] 读真实 app DB settings 失败: ${e.message}`);
}

const outfile = path.join(root, ".agent-crud-bundle.mjs");

await build({
  entryPoints: [path.join(root, "agent-crud.test.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // 关键: 把 Tauri 插件与 db 层替换为测试 shim (node:sqlite 内存库 + 全局 fetch)
  alias: {
    "@tauri-apps/plugin-sql": shim("sql.ts"),
    "@tauri-apps/plugin-http": shim("http.ts"),
    "@tauri-apps/plugin-notification": shim("notify.ts"),
    "@/lib/db": shim("db.ts"),
  },
  // ai SDK / react 等不参与打包: 测试只走 runAgentLoop 路径, 不 import 它们
  external: [
    "ai",
    "@ai-sdk/*",
    "react",
    "react-dom",
    "@tanstack/react-query",
    "zod",
    "date-fns",
  ],
  logLevel: "warning",
});

console.log(`bundle → ${outfile}`);
const child = spawn(process.execPath, [outfile], {
  stdio: "inherit",
  env: { ...process.env },
});
child.on("exit", (code) => {
  try {
    fs.rmSync(outfile, { force: true });
  } catch {
    /* ignore */
  }
  process.exit(code ?? 0);
});
