// Desktop notifications via tauri-plugin-notification (design doc §2.6).

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getSetting } from "@/lib/db";

let permissionReady: Promise<boolean> | null = null;

async function ensurePermission(): Promise<boolean> {
  if (!permissionReady) {
    permissionReady = (async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          granted = (await requestPermission()) === "granted";
        }
        return granted;
      } catch {
        return false;
      }
    })();
  }
  return permissionReady;
}

/** Fire a notification if the user enabled them in settings. */
export async function notify(
  title: string,
  body?: string,
): Promise<void> {
  try {
    const enabled = await getSetting<boolean>("notifications", true);
    if (!enabled) return;
    const granted = await ensurePermission();
    if (!granted) return;
    sendNotification({ title, body });
  } catch {
    // notifications are best-effort
  }
}
