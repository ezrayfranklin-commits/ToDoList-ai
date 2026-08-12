// 日历 CRUD Skill: 统一入口.
// 纯数据层, 无 React/AI 依赖; AI 工具 (src/lib/ai/tools.ts) 与前端 hooks
// 均可调用. 保证任意日期任务的增删改查都可定位、可执行、可审计.

export {
  findTasks,
  findOneTask,
  findTaskCandidates,
  createTask,
  updateTask,
  deleteTask,
  deleteTasksByQuery,
  verifyTaskGone,
  getTaskById,
} from "@/lib/calendar/tasks";
export type { FindTaskOptions } from "@/lib/calendar/tasks";
export { logToolCall, recentToolCalls } from "@/lib/calendar/audit";
export type { ToolCallRecord } from "@/lib/calendar/audit";
