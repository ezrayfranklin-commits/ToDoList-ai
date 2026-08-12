// 设置页: AI 提供商（OpenAI 兼容/Anthropic/Ollama 一键切换，Base URL 开放支持
// DeepSeek 等第三方端点）、定时开关、提醒事项桥接状态、长期目标管理（规划 §2.4/§2.6/§4.1）。

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import {
  Bot,
  Cable,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Clock,
  Loader2,
  Plus,
  Target,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { toast } from "sonner";
import { useSettings } from "@/store/settings";
import { PROVIDERS, pingModel, type ProviderId } from "@/lib/ai/provider";
import { checkRemindersBridge, requestBridgeAuthorization, type BridgeStatus } from "@/lib/reminders";
import { nextRuns } from "@/lib/scheduler";
import { useCreateGoal, useDeleteGoal, useGoals } from "@/hooks/queries";

/**
 * Model picker: searchable preset list + free-text custom model names
 * (shadcn Command + Popover, assembled from existing components).
 * Needed because third-party OpenAI-compatible endpoints use their own
 * model names (e.g. deepseek-chat) that are not in any fixed list.
 */
function ModelCombobox({
  value,
  models,
  onChange,
}: {
  value: string;
  models: readonly string[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = models.filter((m) => m.includes(q.trim()));
  const custom = q.trim() && !models.includes(q.trim());
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{value || "选择或输入模型名"}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput
            placeholder="搜索预设，或直接输入自定义模型名…"
            value={q}
            onValueChange={setQ}
          />
          <CommandList>
            {filtered.map((m) => (
              <CommandItem
                key={m}
                value={m}
                onSelect={() => {
                  onChange(m);
                  setOpen(false);
                }}
              >
                <Check className={m === value ? "opacity-100" : "opacity-0"} />
                {m}
              </CommandItem>
            ))}
            {custom && (
              <CommandItem
                value={`custom:${q}`}
                onSelect={() => {
                  onChange(q.trim());
                  setOpen(false);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                使用自定义模型：{q.trim()}
              </CommandItem>
            )}
            {filtered.length === 0 && !custom && (
              <CommandEmpty>没有匹配的模型</CommandEmpty>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const { data: goals } = useGoals();
  const createGoal = useCreateGoal();
  const deleteGoal = useDeleteGoal();

  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [newGoal, setNewGoal] = useState("");
  const [newGoalDate, setNewGoalDate] = useState("");

  useEffect(() => {
    checkRemindersBridge().then(setBridge);
  }, []);

  const authorize = async () => {
    setBridgeBusy(true);
    const s = await requestBridgeAuthorization();
    setBridge(s);
    setBridgeBusy(false);
    if (s.authorized) {
      toast.success("已授权，可读取 Apple 提醒事项/日历");
    } else {
      toast.info(s.detail);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await pingModel(settings);
    setTestResult(res);
    setTesting(false);
  };

  const addGoal = async () => {
    const t = newGoal.trim();
    if (!t) return;
    await createGoal.mutateAsync({ title: t, targetDate: newGoalDate || undefined });
    setNewGoal("");
    setNewGoalDate("");
    toast.success("已添加长期目标");
  };

  const provider = PROVIDERS.find((p) => p.id === settings.provider) ?? PROVIDERS[2];
  const runs = nextRuns();

  /**
   * Switch provider; if the current base URL is still the previous
   * provider's default (user never customized it), swap in the new
   * provider's default endpoint automatically.
   */
  const switchProvider = (v: ProviderId) => {
    const prev = PROVIDERS.find((p) => p.id === settings.provider);
    const next = PROVIDERS.find((p) => p.id === v);
    const current = settings.baseUrl.trim();
    const isDefault = prev?.defaultBaseUrl && current === prev.defaultBaseUrl;
    const baseUrl = isDefault || !current ? (next?.defaultBaseUrl ?? current) : current;
    settings.update({ provider: v, baseUrl });
  };

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold tracking-tight">设置</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          本地优先：数据存于本机 SQLite；模型可选云端或本地 Ollama（隐私模式）
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {/* AI Provider */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <Bot className="h-4 w-4" /> AI 模型
            </CardTitle>
            <CardDescription>规划与复盘智能体使用的模型</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>提供商</Label>
              <Select value={settings.provider} onValueChange={switchProvider}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{provider.hint}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>模型（可搜索或自定义输入）</Label>
              <ModelCombobox
                value={settings.model}
                models={provider.models}
                onChange={(v) => settings.update({ model: v })}
              />
            </div>

            {settings.provider !== "anthropic" && (
              <div className="flex flex-col gap-1.5">
                <Label>
                  {settings.provider === "ollama" ? "Ollama 地址" : "Base URL（OpenAI 兼容端点）"}
                </Label>
                <Input
                  value={settings.baseUrl}
                  onChange={(e) => settings.update({ baseUrl: e.target.value })}
                  placeholder={
                    settings.provider === "ollama"
                      ? "http://localhost:11434/v1"
                      : "https://api.openai.com/v1（DeepSeek: https://api.deepseek.com）"
                  }
                />
                {settings.provider === "openai" && (
                  <p className="text-[11px] text-muted-foreground">
                    官方 OpenAI 填 https://api.openai.com/v1；DeepSeek 填
                    https://api.deepseek.com；其他 OpenAI 兼容服务商同理（{provider.hint}
                    ）。模型名同步改为服务商对应的名称，如 deepseek-chat。
                  </p>
                )}
                {settings.provider === "ollama" && (
                  <p className="text-[11px] text-muted-foreground">
                    需要先运行 <code className="rounded bg-secondary px-1">ollama serve</code>
                    {" "}并拉取模型
                  </p>
                )}
              </div>
            )}

            {settings.provider !== "ollama" && (
              <div className="flex flex-col gap-1.5">
                <Label>API Key（仅存本机 SQLite）</Label>
                <Input
                  type="password"
                  value={settings.apiKey}
                  onChange={(e) => settings.update({ apiKey: e.target.value })}
                  placeholder="sk-..."
                />
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={test} disabled={testing}>
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cable className="h-3.5 w-3.5" />}
                测试连接
              </Button>
              {testResult && (
                <span
                  className={`flex items-center gap-1.5 text-[12px] ${
                    testResult.ok ? "text-emerald-600" : "text-destructive"
                  }`}
                >
                  {testResult.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5" />
                  )}
                  <span className="max-w-[280px] truncate">{testResult.detail}</span>
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Automation */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <Clock className="h-4 w-4" /> 自动化
            </CardTitle>
            <CardDescription>每日 08:00 自动规划，21:00 晚间复盘（cron-parser 定时）</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">每日自动规划</div>
                <div className="text-[11px] text-muted-foreground">
                  下次运行：{runs[0] ? format(runs[0].at, "M月d日 HH:mm", { locale: zhCN }) : "—"}
                </div>
              </div>
              <Switch
                checked={settings.autoPlan}
                onCheckedChange={settings.setAutoPlan}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">晚间自动复盘</div>
                <div className="text-[11px] text-muted-foreground">
                  下次运行：{runs[1] ? format(runs[1].at, "M月d日 HH:mm", { locale: zhCN }) : "—"}
                </div>
              </div>
              <Switch checked={settings.autoReview} onCheckedChange={(v) => settings.update({ autoReview: v })} />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">桌面通知</div>
                <div className="text-[11px] text-muted-foreground">计划生成与复盘完成时提醒</div>
              </div>
              <Switch
                checked={settings.notifications}
                onCheckedChange={settings.setNotifications}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">未完成自动顺延</div>
                <div className="text-[11px] text-muted-foreground">复盘时将未完成任务移至明日</div>
              </div>
              <Switch
                checked={settings.carryOver}
                onCheckedChange={settings.setCarryOver}
              />
            </div>
          </CardContent>
        </Card>

        {/* macOS bridge */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <Cable className="h-4 w-4" /> macOS 联动
            </CardTitle>
            <CardDescription>通过 remindctl 桥接 Apple 提醒事项/日历（规划 §2.6）</CardDescription>
          </CardHeader>
          <CardContent>
            {bridge === null ? (
              <p className="text-[12px] text-muted-foreground">检测中…</p>
            ) : (
              <div className="flex items-center gap-2 text-[12px]">
                {bridge.installed && bridge.authorized ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <XCircle className="h-4 w-4 text-amber-500" />
                )}
                <span>
                  {bridge.installed ? (
                    <span className="font-medium">remindctl {bridge.authorized ? "已授权" : "未授权"}</span>
                  ) : (
                    <span className="font-medium">未安装 remindctl</span>
                  )}
                  <span className="ml-1 text-muted-foreground">{bridge.detail}</span>
                </span>
              </div>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              授权后，规划智能体将读取今日提醒/日历会议，自动避开会议时间排任务。
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={bridgeBusy}
                onClick={authorize}
              >
                {bridgeBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Cable className="mr-1 h-3 w-3" />}
                授权/重新检测
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Goals */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <Target className="h-4 w-4" /> 长期目标
            </CardTitle>
            <CardDescription>规划智能体会在排期时参考这些目标</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Input
                value={newGoal}
                onChange={(e) => setNewGoal(e.target.value)}
                placeholder="例如：12 月完成英语考试"
              />
              <Input
                type="date"
                value={newGoalDate}
                onChange={(e) => setNewGoalDate(e.target.value)}
                className="w-40"
              />
              <Button onClick={addGoal} disabled={!newGoal.trim()} className="gap-1">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {(goals ?? []).length === 0 ? (
              <p className="py-2 text-center text-[12px] text-muted-foreground">还没有长期目标</p>
            ) : (
              <div className="flex flex-col divide-y divide-border">
                {(goals ?? []).map((g) => (
                  <div key={g.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px]">{g.title}</div>
                      {g.targetDate && (
                        <div className="text-[11px] text-muted-foreground">
                          截止 {format(new Date(g.targetDate + "T00:00:00"), "yyyy-MM-dd")}
                        </div>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteGoal.mutate(g.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <p className="pb-4 text-center text-[11px] text-muted-foreground">
          TodoList AI v0.1.0 · 数据存储于本机 SQLite（tauri-plugin-sql）
        </p>
      </div>
    </div>
  );
}
