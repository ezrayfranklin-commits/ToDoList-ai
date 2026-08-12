// 复盘页 (规划 §4.1 晚间复盘): 完成度统计 + AI 总结 + 未完成顺延。

import { useState } from "react";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import ReactMarkdown from "react-markdown";
import { CalendarDays, Loader2, Moon, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useDayStats, usePlan, usePlans } from "@/hooks/queries";
import { runReview } from "@/lib/agent";
import { todayStr } from "@/lib/dates";
import { planProgress } from "@/lib/ai/plan";
import type { DailyPlan } from "@/lib/types";

function PlanCard({ plan }: { plan: DailyPlan }) {
  const stats = plan.data
    ? { done: plan.data.timeBlocks.filter((b) => b.done).length, total: plan.data.timeBlocks.length }
    : { done: 0, total: 0 };
  const pct = planProgress(plan);
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[13px]">
            {format(new Date(plan.planDate + "T00:00:00"), "M月d日", { locale: zhCN })}
          </CardTitle>
          <div className="flex items-center gap-2">
            {plan.status === "reviewed" && <Badge variant="secondary">已复盘</Badge>}
            {plan.status === "confirmed" && <Badge variant="outline">已确认</Badge>}
            {plan.status === "draft" && <Badge className="border-accent/30 bg-accent/10 text-accent">草稿</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-3">
          <Progress value={pct} className="h-1.5 flex-1" />
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {stats.done}/{stats.total}
          </span>
        </div>
        {plan.summary ? (
          <div className="prose-sm max-w-none text-[12px] leading-relaxed text-muted-foreground [&_p]:m-0 [&_li]:m-0 [&_ul]:mt-1 [&_ul]:pl-4 [&_ol]:mt-1 [&_ol]:pl-4">
            <ReactMarkdown>{plan.summary}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">还没有复盘总结</p>
        )}
      </CardContent>
    </Card>
  );
}

export function ReviewPage() {
  const today = todayStr();
  const [dateStr, setDateStr] = useState(today);
  const [reviewing, setReviewing] = useState(false);
  const { data: plan, isLoading } = usePlan(dateStr);
  const { data: stats } = useDayStats(dateStr);
  const { data: plans } = usePlans();

  const startReview = async () => {
    setReviewing(true);
    const res = await runReview(dateStr);
    setReviewing(false);
    if (res.ok) toast.success("复盘完成，未完成任务已顺延至明日");
    else toast.error(`复盘失败：${res.error}`);
  };

  const dateLabel = format(new Date(dateStr + "T00:00:00"), "M月d日 EEEE", { locale: zhCN });

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">复盘</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            晚间总结完成度，未完成任务自动顺延至明日
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="gap-1.5 font-normal">
                <CalendarDays className="h-4 w-4" />
                {dateLabel}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={new Date(dateStr + "T00:00:00")}
                onSelect={(d) => d && setDateStr(format(d, "yyyy-MM-dd"))}
              />
            </PopoverContent>
          </Popover>
          <Button onClick={startReview} disabled={reviewing} className="gap-1.5">
            {reviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Moon className="h-4 w-4" />}
            开始复盘
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <Tabs defaultValue="overview" className="mt-2">
          <TabsList>
            <TabsTrigger value="overview">总览</TabsTrigger>
            <TabsTrigger value="detail">计划详情</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4 space-y-3">
            <Card>
              <CardContent className="grid grid-cols-3 gap-4 py-5 text-center">
                <div>
                  <div className="text-2xl font-bold tabular-nums">{stats?.done ?? 0}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">已完成</div>
                </div>
                <div>
                  <div className="text-2xl font-bold tabular-nums">{stats?.scheduled ?? 0}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">未完成</div>
                </div>
                <div>
                  <div className="text-2xl font-bold tabular-nums">{stats?.percent ?? 0}%</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">完成率</div>
                </div>
              </CardContent>
            </Card>
            {plan?.data && <PlanCard plan={plan} />}
            {!plan && (
              <Card className="py-10">
                <CardContent className="flex flex-col items-center gap-2 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-lg">
                    🌙
                  </div>
                  <p className="text-[13px] font-medium">这一天没有生成计划</p>
                  <p className="text-[12px] text-muted-foreground">
                    点击「开始复盘」也会生成一份完成度总结
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="detail" className="mt-4">
            {plan?.data?.timeBlocks.length ? (
              <Card>
                <CardContent className="flex flex-col divide-y divide-border py-1">
                  {plan.data.timeBlocks.map((b, i) => (
                    <div key={b.key ?? i} className="flex items-center gap-3 py-2.5">
                      <span className="w-24 shrink-0 text-[12px] font-medium tabular-nums text-muted-foreground">
                        {b.start}–{b.end}
                      </span>
                      <span
                        className={
                          b.done
                            ? "flex-1 text-[13px] text-muted-foreground line-through"
                            : "flex-1 text-[13px]"
                        }
                      >
                        {b.title}
                      </span>
                      <Badge variant={b.done ? "secondary" : "outline"} className="text-[10px]">
                        {b.done ? "完成" : "未完成"}
                      </Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : (
              <Card className="py-8">
                <CardContent className="text-center text-[12px] text-muted-foreground">
                  该日期没有计划详情
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      )}

      <div className="mt-8">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-[13px] font-semibold">历史复盘</h2>
          <RefreshCw className="h-3 w-3 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-2">
          {(plans ?? [])
            .filter((p) => p.planDate !== dateStr)
            .slice(0, 7)
            .map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
          {(plans ?? []).filter((p) => p.planDate !== dateStr).length === 0 && (
            <p className="py-4 text-center text-[12px] text-muted-foreground">暂无历史计划</p>
          )}
        </div>
      </div>
    </div>
  );
}
