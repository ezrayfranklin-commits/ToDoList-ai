// 测试 shim: 替代 @tauri-apps/plugin-notification (Node 测试不发送系统通知).

export async function isPermissionGranted(): Promise<boolean> {
  return true;
}
export async function requestPermission(): Promise<"granted"> {
  return "granted";
}
export function sendNotification(_options: unknown): void {
  /* no-op */
}
