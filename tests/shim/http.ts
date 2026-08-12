// 测试 shim: 替代 @tauri-apps/plugin-http (Node 直接用全局 fetch).

export const fetch = globalThis.fetch.bind(globalThis);
export default { fetch };
