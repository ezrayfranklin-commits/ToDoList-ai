// ErrorBoundary: 渲染崩溃兜底（防白屏）。
// 任何子组件渲染异常时展示错误卡片 + 恢复按钮，而不是整页空白。

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 输出到控制台便于排查（webview devtools / 日志）
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          fontFamily: "-apple-system, sans-serif",
          padding: 40,
          color: "#111111",
          background: "#fafafa",
          height: "100%",
          overflow: "auto",
        }}
      >
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>页面出错了</h2>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            fontSize: 12,
            color: "#e5484d",
            background: "#fff",
            border: "1px solid #e5e5e5",
            borderRadius: 8,
            padding: 12,
          }}
        >
          {this.state.error.message}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          style={{
            marginTop: 12,
            padding: "6px 16px",
            borderRadius: 8,
            border: "1px solid #e5e5e5",
            background: "#fff",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          重试
        </button>
      </div>
    );
  }
}
