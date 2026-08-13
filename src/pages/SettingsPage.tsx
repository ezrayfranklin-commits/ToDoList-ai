// 设置页: AI 提供商（OpenAI 兼容/Anthropic/Ollama 一键切换，Base URL 开放支持
// DeepSeek 等第三方端点）、定时开关、提醒事项桥接状态、长期目标管理（规划 §2.4/§2.6/§4.1）。

import { useState } from "react";
import { format } from "date-fns";
import {
  Bot,
  Cable,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Clock,
  Languages,
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
import { PROVIDERS, pingModel, providerLabelT, providerHintT, type ProviderId } from "@/lib/ai/provider";
import { nextRuns } from "@/lib/scheduler";
import { useCreateGoal, useDeleteGoal, useGoals } from "@/hooks/queries";
import { t, dateLocale } from "@/lib/i18n";

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
          <span className="truncate">{value || t("settings.selectModel")}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput
            placeholder={t("settings.searchModel")}
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
                {t("settings.customModel", { name: q.trim() })}
              </CommandItem>
            )}
            {filtered.length === 0 && !custom && (
              <CommandEmpty>{t("settings.noModel")}</CommandEmpty>
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

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [newGoal, setNewGoal] = useState("");
  const [newGoalDate, setNewGoalDate] = useState("");

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await pingModel(settings);
    setTestResult(res);
    setTesting(false);
  };

  const addGoal = async () => {
    const trimmed = newGoal.trim();
    if (!trimmed) return;
    await createGoal.mutateAsync({ title: trimmed, targetDate: newGoalDate || undefined });
    setNewGoal("");
    setNewGoalDate("");
    toast.success(t("settings.goalAdded"));
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
        <h1 className="text-xl font-bold tracking-tight">{t("settings.title")}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {t("settings.subtitle")}
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {/* AI Provider */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <Bot className="h-4 w-4" /> {t("settings.ai")}
            </CardTitle>
            <CardDescription>{t("settings.aiDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>{t("settings.provider")}</Label>
              <Select value={settings.provider} onValueChange={switchProvider}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {providerLabelT(p.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{providerHintT(settings.provider)}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>{t("settings.model")}</Label>
              <ModelCombobox
                value={settings.model}
                models={provider.models}
                onChange={(v) => settings.update({ model: v })}
              />
            </div>

            {settings.provider !== "anthropic" && (
              <div className="flex flex-col gap-1.5">
                <Label>
                  {settings.provider === "ollama" ? t("settings.ollamaUrl") : t("settings.baseUrl")}
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
                    {t("settings.openaiUrlHint")}
                  </p>
                )}
                {settings.provider === "ollama" && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("settings.ollamaUrlHint")} <code className="rounded bg-secondary px-1">ollama serve</code>
                  </p>
                )}
              </div>
            )}

            {settings.provider !== "ollama" && (
              <div className="flex flex-col gap-1.5">
                <Label>{t("settings.apiKey")}</Label>
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
                {t("settings.test")}
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
              <Clock className="h-4 w-4" /> {t("settings.automation")}
            </CardTitle>
            <CardDescription>{t("settings.automationDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">{t("settings.autoPlan")}</div>
                <div className="text-[11px] text-muted-foreground">
                  {t("settings.nextRun", { time: runs[0] ? format(runs[0].at, "MMM d HH:mm", { locale: dateLocale() }) : "—" })}
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
                <div className="text-[13px] font-medium">{t("settings.autoReview")}</div>
                <div className="text-[11px] text-muted-foreground">
                  {t("settings.nextRun", { time: runs[1] ? format(runs[1].at, "MMM d HH:mm", { locale: dateLocale() }) : "—" })}
                </div>
              </div>
              <Switch checked={settings.autoReview} onCheckedChange={(v) => settings.update({ autoReview: v })} />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">{t("settings.notifications")}</div>
                <div className="text-[11px] text-muted-foreground">{t("settings.notificationsDesc")}</div>
              </div>
              <Switch
                checked={settings.notifications}
                onCheckedChange={settings.setNotifications}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">{t("settings.carryOver")}</div>
                <div className="text-[11px] text-muted-foreground">{t("settings.carryOverDesc")}</div>
              </div>
              <Switch
                checked={settings.carryOver}
                onCheckedChange={settings.setCarryOver}
              />
            </div>
          </CardContent>
        </Card>

        {/* Interface language */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <Languages className="h-4 w-4" /> {t("settings.language")}
            </CardTitle>
            <CardDescription>{t("settings.languageDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Button
                variant={settings.lang === "zh" ? "default" : "outline"}
                size="sm"
                onClick={() => settings.setLang("zh")}
              >
                {t("settings.langZh")}
              </Button>
              <Button
                variant={settings.lang === "en" ? "default" : "outline"}
                size="sm"
                onClick={() => settings.setLang("en")}
              >
                {t("settings.langEn")}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* macOS bridge (开发中, 暂不启用) */}
        <Card className="opacity-60 grayscale select-none">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <Cable className="h-4 w-4" /> {t("settings.macBridge")}
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {t("settings.macBridgeBadge")}
              </span>
            </CardTitle>
            <CardDescription>{t("settings.macBridgeDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {t("settings.macBridgeBody")}
            </p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" disabled>
                <Cable className="mr-1 h-3 w-3" />
                {t("settings.macBridgeAuth")}
              </Button>
              <Button size="sm" variant="outline" disabled>
                <Target className="mr-1 h-3 w-3" />
                {t("settings.macBridgeSettings")}
              </Button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {t("settings.macBridgeComing")}
            </p>
          </CardContent>
        </Card>

        {/* Goals */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <Target className="h-4 w-4" /> {t("settings.goals")}
            </CardTitle>
            <CardDescription>{t("settings.goalsDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Input
                value={newGoal}
                onChange={(e) => setNewGoal(e.target.value)}
                placeholder={t("settings.goalPlaceholder")}
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
              <p className="py-2 text-center text-[12px] text-muted-foreground">{t("settings.noGoals")}</p>
            ) : (
              <div className="flex flex-col divide-y divide-border">
                {(goals ?? []).map((g) => (
                  <div key={g.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px]">{g.title}</div>
                      {g.targetDate && (
                        <div className="text-[11px] text-muted-foreground">
                          {t("settings.goalDeadline", { date: format(new Date(g.targetDate + "T00:00:00"), "yyyy-MM-dd") })}
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
          {t("settings.footer")}
        </p>
      </div>
    </div>
  );
}
