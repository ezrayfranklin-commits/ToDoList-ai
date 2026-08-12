// Entry: init SQLite (+ migrations) first, then mount the app.

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initDb } from "@/lib/db";
import { useSettings } from "@/store/settings";
import "./index.css";

async function bootstrap() {
  await initDb();
  await useSettings.getState().load();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

bootstrap().catch((e) => {
  console.error("Failed to bootstrap:", e);
  document.getElementById("root")!.innerHTML =
    `<div style="font-family: -apple-system, sans-serif; padding: 40px; color: #e5484d;">
      <h2>启动失败</h2>
      <pre style="white-space: pre-wrap; font-size: 12px;">${String(e)}</pre>
    </div>`;
});
