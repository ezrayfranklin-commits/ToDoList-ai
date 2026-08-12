// 对话运行状态（全局, v0.10）:
// 生成过程提升到组件外 —— 切换页面/切到别的软件后, 生成在后台继续,
// 回到对话页时"思考中"与停止按钮状态仍然保留。
// 停止按钮通过 AbortController 中止本轮生成。

import { create } from "zustand";

interface ChatRunState {
  /** 是否正在生成回复（全局, 组件卸载不丢） */
  running: boolean;
  controller: AbortController | null;
  /** 开始一轮生成, 返回该轮的 AbortController */
  startRun: () => AbortController;
  /** 用户点击停止: 中止本轮生成并清空状态 */
  stopRun: () => void;
  /** 一轮生成正常结束（不 abort, 只清状态） */
  finishRun: (ctrl: AbortController) => void;
  /** 该 controller 是否仍是当前轮 */
  isCurrent: (ctrl: AbortController) => boolean;
}

export const useChatRun = create<ChatRunState>((set, get) => ({
  running: false,
  controller: null,
  startRun: () => {
    const ctrl = new AbortController();
    set({ running: true, controller: ctrl });
    return ctrl;
  },
  stopRun: () => {
    get().controller?.abort();
    set({ running: false, controller: null });
  },
  finishRun: (ctrl) => {
    if (get().controller === ctrl) {
      set({ running: false, controller: null });
    }
  },
  isCurrent: (ctrl) => get().controller === ctrl,
}));
