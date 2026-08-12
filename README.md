# TodoList AI — macOS 智能待办

> Tauri v2 做壳 + shadcn/ui 浅色极简 UI + SQLite/Drizzle 存数据 +
> Vercel AI SDK / OpenAI-compatible 协议做规划智能体 + remindctl 桥接
> Apple 提醒事项。本地优先，模型可选云端（OpenAI/Anthropic）或本地（Ollama）。

一个 macOS 原生体验的待办应用：AI 智能体每天自动帮你规划当天要做什么。
读取你的日历/提醒事项、未完成任务、Inbox、长期目标，自动生成**今日计划**
（时间块 + 优先级 + 避让会议），确认后可拖拽调整，晚间自动复盘并顺延未完成任务。

## 功能

- **Inbox 随手记** — ⌘K 快速收集，之后交给 AI 归类
- **对话式首页** — 今日页顶部是 AI 助手对话面板：用自然语言「规划今天」「加任务：买咖啡」「把 … 顺延到明天」「完成 …」，同时下方保留逐条待办时间块（勾选/拖拽）；模型不可用时自动降级为关键词指令
- **每日自动规划** — 08:00 定时（cron-parser），可手动「一键规划」；先出草稿、确认后写回任务（Plan-and-Execute）
- **计划确认与调整** — dnd-kit 拖拽排序时间块、增删任务
- **执行与跟踪** — 勾选完成、进度条、时间块展示
- **晚间复盘** — 21:00 智能体总结完成度，未完成任务自动顺延明日
- **系统联动** — 通过 remindctl 桥接读取 Apple 提醒事项/日历（M3，需授权）
- **本地优先** — SQLite（tauri-plugin-sql）+ Drizzle 迁移；Ollama 隐私模式

## OpenAI 兼容端点（DeepSeek 等第三方）

设置页「AI 模型」的 Base URL 已开放：官方 OpenAI 填 `https://api.openai.com/v1`，
DeepSeek 填 `https://api.deepseek.com`，其他 OpenAI 兼容服务商同理；模型名支持自定义输入
（如 `deepseek-chat`、`deepseek-reasoner`）。切换提供商时若未自定义端点会自动替换为对应默认值。

## 快速开始

```bash
npm install
# 本地模型（推荐，隐私模式）：
ollama serve        # 默认地址 http://localhost:11434
ollama pull qwen2.5:7b
npm run tauri dev   # 开发
npm run tauri build # 打包 DMG
```

### 配置云端模型（可选）

在「设置」页切换提供商并填入 API Key（仅存本机 SQLite）：
- OpenAI：`gpt-4o-mini` / `gpt-4o`
- Anthropic：`claude-sonnet-4-20250514` 等
- Ollama（本地）：`qwen2.5:7b` 等

## 编码规范

### 提交与热更新（每次改动必做）

- **每次改完保存一个 Git 版本**：一次逻辑改动对应一个 commit，不留未提交的散改动；
  消息用 Conventional Commits 前缀（`feat:` / `fix:` / `ui:` / `style:` / `docs:` /
  `refactor:` / `chore:`）+ 英文简洁描述
- **改完重启应用**：前端改动在 `npm run tauri dev` 下由 Vite HMR 自动热更新；
  改动涉及 Rust（`src-tauri/`）或 dev 进程未在跑时需重启（`Ctrl+C` 后重新
  `npm run tauri dev`）。收尾动作统一为：提交 Git 版本 → 确认应用热更新/重启生效

### 代码风格

- **浅色极简主题**（参考 Things 3 / TickTick 浅色模式）：背景 `#FAFAFA`、卡片纯白
  `#FFFFFF`、分隔线 `#E5E5E5`；单一强调色（低饱和，如 `#4A6CF7`）；标题 600/700 字重、
  正文 400，字号三档 16/14/12；圆角统一 `rounded-lg`（卡片 `rounded-xl`）；阴影仅
  `shadow-sm` 悬浮态；大留白（列表项 12px、页面 24px）；系统字体 SF Pro，数字用
  `tabular-nums`；动效 200ms ease-out，仅 hover/check 反馈
- **只拼装现有成熟模块，不手写组件代码**：UI 一律用 shadcn/ui 现成组件拼装，改色板即可；
  有现成库（date-fns / dnd-kit / TanStack Query 等）不重复造轮子
- **TanStack Query 统一数据入口**：数据读写走 `hooks/queries.ts` 的 hooks/mutations，不散落 fetch
- **中文注释使用半角标点**：代码内注释（含中文注释）一律用 ASCII 半角标点
  （`:` `,` `(` `)` `.`），不用全角中文标点（`，。：；（）「」` 等）；
  面向模型/用户的提示词字符串除外（保持自然中文标点）
- **中文界面无分隔线**：组件间靠留白与气泡区分，不加多余边框分隔
- **版本节奏**：小步提交、可随时回滚；一个改动一个版本，配合热更新即时生效

## 技术栈

| 层 | 选型 |
|----|------|
| 应用壳 | Tauri v2（Rust 后端仅拼装官方插件：sql / notification / shell / autostart / single-instance / http / dialog） |
| 前端 | React 19 + Vite 7 + TypeScript + Tailwind CSS v4 |
| UI | shadcn/ui（radix-nova 样式）+ lucide-react + sonner + dnd-kit + react-markdown + date-fns |
| 状态 | Zustand + TanStack Query（统一数据入口） |
| 数据 | SQLite（tauri-plugin-sql）+ Drizzle schema/迁移（drizzle-kit generate） |
| AI | Vercel AI SDK（OpenAI/Anthropic）+ 自研 Ollama 结构化生成器（工具调用 + schema 校验重试，兼容 Ollama 对复杂 schema 的解析限制） |
| 系统 | remindctl（Apple Reminders CLI）桥接，规避 MCP server 的 alpha 风险 |

## 数据与隐私

- 数据存于 `~/Library/Application Support/com.todolistai.app/todolist.db`
- API Key 仅存本机 SQLite；AI 请求经 tauri-plugin-http（Rust 代理，无 CORS 问题）
- 复盘反馈与 agent 调用日志写入 `agent_runs` 表，供提示词迭代

## 目录结构

```
src/
  db/          Drizzle schema + 迁移 SQL（?raw 打包，启动时执行）
  lib/
    db.ts      数据库初始化/迁移/设置读写
    agent.ts   规划/复盘编排（草稿→确认→写回）
    ai/        provider（模型工厂）/ schemas（zod 严格 schema）/
               ollama（本地结构化生成器）/ plan / review / context
    scheduler.ts  cron 定时（08:00 规划 / 21:00 复盘）
    reminders.ts  remindctl 桥接（日历事件 / 提醒事项）
    notify.ts    桌面通知
  hooks/queries.ts  TanStack Query 数据层
  pages/       今日 / Inbox / 复盘 / 设置
  store/       Zustand（UI 状态 / 设置）
src-tauri/     Rust 壳（插件注册 + single-instance 聚焦）
```

## 里程碑状态

- [x] M0 骨架：create-tauri-app + Tailwind v4 + shadcn/ui + Drizzle schema
- [x] M1 核心待办：今日列表（勾选/拖拽）、Inbox、⌘K、SQLite 持久化、通知
- [x] M2 AI 规划：多提供商（OpenAI/Anthropic/Ollama）、结构化 JSON 时间块、一键规划 + 08:00 定时、确认/调整回写、21:00 复盘 + 顺延
- [x] M3 系统联动：remindctl 桥接（日历事件读取）、菜单栏常驻（single-instance）、开机自启（autostart 插件）
- [~] M4 打磨：浅色主题 + 空状态 + 骨架屏已完成；DMG 已打包（未签名公证）；Ollama 隐私模式已验证

## 已知边界

- DMG 未签名/未公证（个人开发者发布前需 `codesign` + `notarytool`）
- remindctl 需要用户在系统设置中授权「提醒事项」访问
- 复盘/规划的自动定时依赖应用在运行；后台常驻建议开启开机自启
