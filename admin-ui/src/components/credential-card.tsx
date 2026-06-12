import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  RefreshCw,
  GripVertical,
  Trash2,
  Loader2,
  Pencil,
  LogIn,
  MoreHorizontal,
  RotateCcw,
  Zap,
  Clock,
  ScrollText,
  Boxes,
  Server,
  Copy,
  Check,
  KeyRound,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { SubscriptionBadge } from "@/components/subscription-badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CredentialStatusItem, BalanceResponse } from "@/types/api";
import { maskProxyUrl, maskEmail, extractErrorMessage } from "@/lib/utils";
import {
  useSetDisabled,
  useSetPriority,
  useResetFailure,
  useDeleteCredential,
  useForceRefreshToken,
  useResetSuccessCount,
  useClearThrottle,
  useGlobalConfig,
  useSetEndpoint,
} from "@/hooks/use-credentials";
import { setCredentialOverage } from "@/api/credentials";
import { useQueryClient } from "@tanstack/react-query";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EditCredentialDialog } from "@/components/edit-credential-dialog";
import { UpdateTokenDialog } from "@/components/update-token-dialog";
import { ReloginDialog } from "@/components/relogin-dialog";
import { CredentialFailuresDialog } from "@/components/credential-failures-dialog";
import { AvailableModelsDialog } from "@/components/available-models-dialog";

interface CredentialCardProps {
  credential: CredentialStatusItem;
  selected: boolean;
  onToggleSelect: () => void;
  balance: BalanceResponse | null;
  /** 隐私模式：邮箱脱敏展示（复制仍为明文） */
  privacyMode?: boolean;
  loadingBalance: boolean;
  onRefreshBalance: () => void | Promise<void>;
  /** 该凭据的失败分类计数（来自 trace 聚合）；无数据时回退 totalFailureCount */
  failureStats?: { auth: number; throttle: number; other: number };
}

function formatLastUsed(lastUsedAt: string | null): string {
  if (!lastUsedAt) return "从未使用";
  const date = new Date(lastUsedAt);
  const diff = Date.now() - date.getTime();
  if (diff < 0) return "刚刚";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatResetDate(ts: number | null): string {
  if (!ts) return "未知";
  return new Date(ts * 1000).toLocaleString("zh-CN");
}

/** 紧凑重置日期：MM/DD（用于余额面板底部，悬停看完整日期） */
function formatResetShort(ts: number | null): string {
  if (!ts) return "未知";
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

/** 把秒数格式化为 `mm:ss` 或 `hh:mm:ss` */
function formatThrottleCountdown(secs: number): string {
  const total = Math.max(0, Math.floor(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 把普通 429 冷却毫秒数格式化为紧凑倒计时。 */
function formatRateLimitCountdown(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.ceil(ms))}ms`;
  return formatThrottleCountdown(Math.ceil(ms / 1000));
}

/** 超额额度总上限（美元）。上游未在 usageLimits 中返回超额硬上限，
 *  这里用固定 10000 作为进度条参照，使超额条能反映真实占比而非恒满。 */
const OVERAGE_CAP = 10000;

/** 按认证方式给字母头像着色（参考 kiro-account-manager 的 provider 配色） */
function avatarColorClass(authMethod: string | null): string {
  switch (authMethod) {
    case "social":
      return "bg-red-500/10 text-red-500";
    case "idc":
      return "bg-blue-500/10 text-blue-500";
    case "api_key":
      return "bg-slate-500/10 text-slate-500";
    default:
      return "bg-primary/10 text-primary";
  }
}

/**
 * 卡片右上角的单一状态胶囊（uppercase 小字号，参考 AccountCard 风格）。
 * 多状态共存时按严重程度取一个：禁用 > 风控冷却 > 429 限流 > 超额 > 正常。
 */
function StatusPill({
  label,
  tone,
  title,
}: {
  label: string;
  tone: "green" | "red" | "orange" | "amber" | "sky" | "slate";
  title?: string;
}) {
  const toneClass = {
    green: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
    red: "bg-red-500/10 text-red-500 border-red-500/20",
    orange: "bg-orange-500/10 text-orange-500 border-orange-500/20",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    sky: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
    slate: "bg-slate-500/10 text-slate-500 border-slate-500/20",
  }[tone];
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${toneClass}`}
      title={title}
    >
      {label}
    </span>
  );
}

/**
 * 把后端返回的 disabledReason 字符串映射为更直观的中文徽标
 * （颜色/文案/排序权重，越靠前越显眼）
 */
function getDisabledReasonStyle(reason?: string | null): {
  label: string;
  variant: "destructive" | "warning" | "outline" | "secondary";
} | null {
  if (!reason) return null;
  switch (reason) {
    case "QuotaExceeded":
      return { label: "已超额", variant: "warning" };
    case "TooManyFailures":
      return { label: "失败过多", variant: "destructive" };
    case "TooManyRefreshFailures":
      return { label: "刷新失败过多", variant: "destructive" };
    case "InvalidRefreshToken":
      return { label: "Token 失效", variant: "destructive" };
    case "InvalidConfig":
      return { label: "配置无效", variant: "destructive" };
    case "Manual":
      return { label: "手动禁用", variant: "secondary" };
    default:
      return { label: reason, variant: "outline" };
  }
}

export function CredentialCard({
  credential,
  selected,
  onToggleSelect,
  balance,
  privacyMode = false,
  loadingBalance,
  onRefreshBalance,
  failureStats,
}: CredentialCardProps) {
  const [editingPriority, setEditingPriority] = useState(false);
  const [priorityValue, setPriorityValue] = useState(
    String(credential.priority),
  );
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showUpdateTokenDialog, setShowUpdateTokenDialog] = useState(false);
  const [showReloginDialog, setShowReloginDialog] = useState(false);
  const [showFailuresDialog, setShowFailuresDialog] = useState(false);
  const [showModelsDialog, setShowModelsDialog] = useState(false);
  const [endpointValue, setEndpointValue] = useState(
    credential.configuredEndpoint ?? "",
  );
  const [copied, setCopied] = useState(false);

  const setDisabled = useSetDisabled();
  const setPriority = useSetPriority();
  const setEndpoint = useSetEndpoint();
  const resetFailure = useResetFailure();
  const deleteCredential = useDeleteCredential();
  const forceRefresh = useForceRefreshToken();
  const resetSuccess = useResetSuccessCount();
  const clearThrottle = useClearThrottle();
  const queryClient = useQueryClient();
  const { data: globalConfig } = useGlobalConfig();

  useEffect(() => {
    setEndpointValue(credential.configuredEndpoint ?? "");
  }, [credential.configuredEndpoint]);

  // 拖拽排序：手柄触发，整卡随拖动位移
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: credential.id });
  const dragStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    // 拖拽中关掉过渡，避免 Card 基类的 transition-all 把每帧 transform 动画化导致"不跟手"；
    // 非拖拽态保留 dnd-kit 的归位过渡。
    transition: isDragging ? "none" : transition,
    zIndex: isDragging ? 20 : undefined,
  };

  // 后端冷却剩余秒数会在 30s 拉取间隔之间过时，本地用 setInterval 自然递减以让倒计时连续。
  const [throttleRemaining, setThrottleRemaining] = useState<number>(
    credential.throttledRemainingSecs ?? 0,
  );
  useEffect(() => {
    setThrottleRemaining(credential.throttledRemainingSecs ?? 0);
  }, [credential.throttledRemainingSecs]);
  useEffect(() => {
    if (throttleRemaining <= 0) return;
    const t = window.setInterval(() => {
      setThrottleRemaining((v) => (v > 0 ? v - 1 : 0));
    }, 1000);
    return () => window.clearInterval(t);
  }, [throttleRemaining]);

  const rateLimitSourceMs =
    credential.rateLimitedForMs ?? credential.rateLimitedUntilMs ?? 0;
  const [rateLimitRemainingMs, setRateLimitRemainingMs] =
    useState<number>(rateLimitSourceMs);
  useEffect(() => {
    setRateLimitRemainingMs(rateLimitSourceMs);
  }, [rateLimitSourceMs]);
  useEffect(() => {
    if (rateLimitRemainingMs <= 0) return;
    const t = window.setInterval(() => {
      setRateLimitRemainingMs((v) => Math.max(0, v - 1000));
    }, 1000);
    return () => window.clearInterval(t);
  }, [rateLimitRemainingMs]);

  const handleClearThrottle = useCallback(() => {
    clearThrottle.mutate(credential.id, {
      onSuccess: (res) => {
        setThrottleRemaining(0);
        setRateLimitRemainingMs(0);
        toast.success(res.message);
      },
      onError: (err) => toast.error("解除失败: " + extractErrorMessage(err)),
    });
  }, [clearThrottle, credential.id]);
  const [overageBusy, setOverageBusy] = useState(false);
  const handleSetOverage = async (enabled: boolean) => {
    setOverageBusy(true);
    try {
      await setCredentialOverage(credential.id, enabled);
      // 后端切换成功后会清掉该凭据的余额缓存；这里立即重新拉取余额，
      // 让 ⚡ 开关反映上游确认后的真实状态（而不是旧快照弹回）。
      await onRefreshBalance();
      toast.success(enabled ? "已开启超额" : "已关闭超额");
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
    } catch (err) {
      toast.error(
        (enabled ? "开启" : "关闭") + "超额失败: " + extractErrorMessage(err),
      );
    } finally {
      setOverageBusy(false);
    }
  };

  const handleToggleDisabled = () => {
    // 当前为禁用态 → 这次操作是“启用”，启用成功后顺带刷新一次余额
    const willEnable = credential.disabled;
    setDisabled.mutate(
      { id: credential.id, disabled: !credential.disabled },
      {
        onSuccess: (res) => {
          toast.success(res.message);
          if (willEnable) onRefreshBalance();
        },
        onError: (err) => toast.error("操作失败: " + (err as Error).message),
      },
    );
  };

  const handlePriorityChange = () => {
    const np = parseInt(priorityValue, 10);
    if (isNaN(np) || np < 0) {
      toast.error("优先级必须是非负整数");
      return;
    }
    setPriority.mutate(
      { id: credential.id, priority: np },
      {
        onSuccess: (res) => {
          toast.success(res.message);
          setEditingPriority(false);
        },
        onError: (err) => toast.error("操作失败: " + (err as Error).message),
      },
    );
  };

  const handleEndpointChange = (value: string) => {
    setEndpointValue(value);
    setEndpoint.mutate(
      { id: credential.id, endpoint: value || null },
      {
        onSuccess: (res) => toast.success(res.message),
        onError: (err) => {
          setEndpointValue(credential.configuredEndpoint ?? "");
          toast.error("Endpoint 更新失败: " + extractErrorMessage(err));
        },
      },
    );
  };

  const handleReset = () =>
    resetFailure.mutate(credential.id, {
      onSuccess: (res) => toast.success(res.message),
      onError: (err) => toast.error("操作失败: " + (err as Error).message),
    });

  const handleForceRefresh = () =>
    forceRefresh.mutate(credential.id, {
      onSuccess: (res) => toast.success(res.message),
      onError: (err) => toast.error("刷新失败: " + extractErrorMessage(err)),
    });

  const handleResetSuccess = () =>
    resetSuccess.mutate(credential.id, {
      onSuccess: (res) => toast.success(res.message),
      onError: (err) => toast.error("重置失败: " + (err as Error).message),
    });

  const handleDelete = () => {
    if (!credential.disabled) {
      toast.error("请先禁用凭据再删除");
      setShowDeleteDialog(false);
      return;
    }
    deleteCredential.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message);
        setShowDeleteDialog(false);
      },
      onError: (err) => toast.error("删除失败: " + (err as Error).message),
    });
  };

  const authLabel =
    credential.authMethod === "api_key"
      ? "API Key"
      : credential.authMethod === "idc"
        ? "IdC"
        : credential.authMethod === "social"
          ? "Social"
          : credential.authMethod;

  const isQuotaExceeded = balance
    ? balance.remaining <= 0 || balance.usagePercentage >= 100
    : false;

  const disabledByQuota =
    credential.disabled && credential.disabledReason === "QuotaExceeded";
  const reasonStyle = getDisabledReasonStyle(credential.disabledReason);
  const isThrottled = !credential.disabled && throttleRemaining > 0;
  const isRateLimited = !credential.disabled && rateLimitRemainingMs > 0;

  const displayName = credential.email || `凭据 #${credential.id}`;
  // 隐私模式只影响展示，复制仍是明文
  const shownName =
    privacyMode && credential.email ? maskEmail(credential.email) : displayName;
  const handleCopyName = async () => {
    try {
      await navigator.clipboard.writeText(displayName);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败");
    }
  };

  // 状态胶囊：多状态共存时取最重要的一个
  const statusPill = credential.disabled
    ? {
        label: reasonStyle ? `禁用 · ${reasonStyle.label}` : "已禁用",
        tone:
          reasonStyle?.variant === "warning"
            ? ("amber" as const)
            : reasonStyle?.variant === "secondary"
              ? ("slate" as const)
              : ("red" as const),
        title: credential.disabledReason ?? "已禁用",
      }
    : isThrottled
      ? {
          label: `冷却 ${formatThrottleCountdown(throttleRemaining)}`,
          tone: "orange" as const,
          title: "账号级风控冷却中（429 + suspicious activity），到期或手动解除后恢复调度",
        }
      : isRateLimited
        ? {
            label: `429 ${formatRateLimitCountdown(rateLimitRemainingMs)}`,
            tone: "sky" as const,
            title: "普通 429 限流冷却中，调度会临时跳过此凭据",
          }
        : isQuotaExceeded
          ? {
              label: "超额中",
              tone: "amber" as const,
              title: "基础额度已用满",
            }
          : {
              label: "正常",
              tone: "green" as const,
              title: "状态正常",
            };

  return (
    <>
      <Card
        ref={setNodeRef}
        style={dragStyle}
        data-credential-id={credential.id}
        className={`group relative flex h-full flex-col ${
          isDragging
            ? "shadow-apple-lg opacity-80"
            : "hover:-translate-y-0.5 hover:shadow-apple-lg"
        } ${
          // 状态驱动的卡片配色（参考 kiro-account-manager）：选中 > 活跃 > 异常 > 默认
          selected
            ? "ring-2 ring-primary/50 bg-primary/[0.03]"
            : credential.isCurrent
              ? "ring-1 ring-emerald-500/50 bg-emerald-500/[0.03] shadow-emerald-500/10"
              : disabledByQuota
                ? "ring-1 ring-amber-500/70 bg-amber-50/40 dark:bg-amber-500/[0.04]"
                : isThrottled
                  ? "ring-1 ring-orange-500/60 bg-orange-50/40 dark:bg-orange-500/[0.04]"
                  : isRateLimited
                    ? "ring-1 ring-sky-500/50 bg-sky-50/40 dark:bg-sky-500/[0.04]"
                    : !credential.disabled && isQuotaExceeded
                      ? "ring-1 ring-amber-500/60"
                      : ""
        } ${
          // 其他原因被禁用：灰化去色（额度禁用保留可读性，方便审视）
          credential.disabled && !disabledByQuota ? "opacity-60 grayscale" : ""
        }`}
      >
        {/* 活跃凭据：顶部渐变条 */}
        {credential.isCurrent && (
          <div className="pointer-events-none absolute -left-px -right-px -top-px z-10 h-1 rounded-t-2xl bg-gradient-to-r from-emerald-500/80 to-green-400/80" />
        )}

        <CardHeader className="p-4 pb-2.5">
          <div className="flex items-start gap-2.5">
            <label
              data-no-rect-select
              className="mt-1.5 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-accent"
              onClick={(e) => {
                // label + Checkbox 双击事件去重，避免触发两次 onCheckedChange
                e.stopPropagation();
              }}
            >
              <Checkbox
                className="h-4 w-4"
                checked={selected}
                onCheckedChange={onToggleSelect}
              />
            </label>
            {/* 字母头像：按认证方式着色 */}
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/50 text-sm font-bold ${avatarColorClass(credential.authMethod)}`}
            >
              {displayName[0].toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <CardTitle className="truncate text-[14px]">
                  {shownName}
                </CardTitle>
                <button
                  type="button"
                  onClick={handleCopyName}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-primary"
                  title="复制账号"
                >
                  {copied ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                Kiro {authLabel ?? "未知"} 账号 · #{credential.id}
              </div>
            </div>
            {/* 右上角：超额开关 + 启用开关 + 状态胶囊 */}
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              {balance?.overageCapable === true && (
                <div
                  className="flex items-center gap-1"
                  title={
                    balance.overageEnabled
                      ? "已开启超额计费，点击关闭"
                      : "支持超额但未开启，点击开启"
                  }
                >
                  <Zap
                    className={`h-3 w-3 ${balance.overageEnabled ? "text-emerald-500" : "text-muted-foreground/60"}`}
                  />
                  <Switch
                    size="sm"
                    checked={balance.overageEnabled === true}
                    disabled={overageBusy}
                    onCheckedChange={handleSetOverage}
                  />
                </div>
              )}
              <Switch
                size="sm"
                checked={!credential.disabled}
                onCheckedChange={handleToggleDisabled}
                disabled={setDisabled.isPending}
                title={credential.disabled ? "启用凭据" : "禁用凭据"}
              />
              <StatusPill {...statusPill} />
            </div>
          </div>

          {/* 徽章行：订阅 / 认证方式 / Endpoint / ARN */}
          <div className="flex flex-wrap items-center gap-1 pt-1">
            {balance?.subscriptionTitle && (
              <SubscriptionBadge title={balance.subscriptionTitle} />
            )}
            {credential.authMethod && (
              <Badge variant="secondary">{authLabel}</Badge>
            )}
            <Badge
              variant="outline"
              className="gap-1 font-normal"
              title={
                credential.configuredEndpoint
                  ? `显式 endpoint: ${credential.configuredEndpoint}；生效 endpoint: ${credential.effectiveEndpoint}`
                  : `跟随默认 endpoint；生效 endpoint: ${credential.effectiveEndpoint}`
              }
            >
              <Server className="h-3 w-3 opacity-70" />
              {credential.configuredEndpoint || credential.effectiveEndpoint}
            </Badge>
            {credential.hasProfileArn && (
              <Badge variant="outline" title="已配置 Profile ARN">
                ARN
              </Badge>
            )}
          </div>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col space-y-3 p-4 pt-0">
          {/* 信息行：紧凑指标条 — 优先级 / 失败 / 刷新失败 / 成功，最后调用单列右对齐 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">优先级</span>
              {editingPriority ? (
                <span className="inline-flex items-center gap-1">
                  <Input
                    type="number"
                    value={priorityValue}
                    onChange={(e) => setPriorityValue(e.target.value)}
                    className="w-14 h-7 text-sm rounded-md"
                    min="0"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={handlePriorityChange}
                    disabled={setPriority.isPending}
                  >
                    ✓
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => {
                      setEditingPriority(false);
                      setPriorityValue(String(credential.priority));
                    }}
                  >
                    ✕
                  </Button>
                </span>
              ) : (
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium tabular-nums transition-colors hover:bg-accent hover:text-primary"
                  onClick={() => setEditingPriority(true)}
                  title="点击编辑优先级"
                >
                  {credential.priority}
                  <Pencil className="h-3 w-3 opacity-70" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">失败</span>
              <button
                type="button"
                onClick={() => setShowFailuresDialog(true)}
                className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium tabular-nums transition-colors hover:bg-accent"
                title="鉴权失败 / 账号风控 / 其他（额度·瞬态·网络等）。点击查看失败日志详情"
              >
                {failureStats ? (
                  <span className="tabular-nums">
                    <span className="text-destructive">{failureStats.auth}</span>
                    <span className="text-muted-foreground/50">/</span>
                    <span className="text-amber-600 dark:text-amber-400">
                      {failureStats.throttle}
                    </span>
                    <span className="text-muted-foreground/50">/</span>
                    <span className="text-muted-foreground">
                      {failureStats.other}
                    </span>
                  </span>
                ) : (
                  <span
                    className={
                      credential.totalFailureCount > 0
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }
                  >
                    {credential.totalFailureCount}
                  </span>
                )}
                <ScrollText className="h-3.5 w-3.5 opacity-70" />
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">刷新失败</span>
              <span
                className={`px-1.5 tabular-nums font-medium ${credential.refreshFailureCount > 0 ? "text-destructive" : ""}`}
              >
                {credential.refreshFailureCount}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">成功</span>
              <button
                type="button"
                onClick={handleResetSuccess}
                className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium tabular-nums transition-colors hover:bg-accent hover:text-primary"
                title="点击重置成功次数"
              >
                {credential.successCount}
                <RotateCcw className="h-3 w-3 opacity-70" />
              </button>
            </div>

            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-muted-foreground">最后调用</span>
              <span className="font-medium">
                {formatLastUsed(credential.lastUsedAt)}
              </span>
            </div>

            {credential.maskedApiKey && (
              <div className="flex w-full items-center justify-between gap-2 border-t border-border/50 pt-1.5">
                <span className="text-muted-foreground">API Key</span>
                <span className="font-mono text-xs truncate">
                  {credential.maskedApiKey}
                </span>
              </div>
            )}
            {credential.hasProxy && (
              <div className="flex w-full items-center justify-between gap-2">
                <span className="text-muted-foreground">代理</span>
                <span className="font-mono text-xs truncate">
                  {maskProxyUrl(credential.proxyUrl ?? "")}
                </span>
              </div>
            )}
          </div>

          {/* 余额面板 */}
          <div
            className={`flex min-h-[120px] flex-col rounded-xl border p-3 transition-colors ${
              isQuotaExceeded || disabledByQuota
                ? "border-amber-500/40 bg-amber-50/60 dark:bg-amber-500/[0.06]"
                : "border-border/60 bg-secondary/40"
            }`}
          >
            {balance ? (
              // 刷新中不整块替换为 spinner（会闪烁/跳动），而是原位降低透明度 + 角标小动画
              <div
                className={`relative flex flex-1 flex-col transition-opacity duration-300 ${
                  loadingBalance ? "opacity-60" : "opacity-100"
                }`}
              >
                {loadingBalance && (
                  <Loader2 className="absolute right-0 top-0 z-10 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
                {(() => {
                const used = balance.currentUsage;
                const limit = balance.usageLimit;
                const overLimit = limit > 0 && used > limit;
                const basePct =
                  limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
                const overageAmount = overLimit ? used - limit : 0;
                // 超额条以固定的超额总上限（OVERAGE_CAP）为参照，反映真实占比，
                // 而非旧实现里以基础额度为分母导致的恒满。
                const overagePct = Math.min(
                  100,
                  (overageAmount / OVERAGE_CAP) * 100,
                );
                return (
                  <div className="flex flex-1 flex-col gap-3">
                    {/* 主行：剩余 / 超额金额（与标签同基线） */}
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                          {balance.remaining < 0 ? "已超额" : "剩余"}
                        </span>
                        <span
                          className={`text-xl font-semibold tabular-nums leading-none ${
                            balance.remaining < 0
                              ? "text-violet-600 dark:text-violet-400"
                              : balance.remaining === 0
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-emerald-600 dark:text-emerald-400"
                          }`}
                        >
                          {balance.remaining < 0
                            ? `-$${formatNumber(Math.abs(balance.remaining))}`
                            : `$${formatNumber(balance.remaining)}`}
                        </span>
                      </div>
                    </div>

                    {/* 基础额度条 */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] tabular-nums">
                        <span className="text-muted-foreground">额度用量</span>
                        <span
                          className={
                            overLimit
                              ? "font-medium text-violet-600 dark:text-violet-400"
                              : basePct > 80
                                ? "font-medium text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground"
                          }
                        >
                          ${formatNumber(Math.min(used, limit))} / $
                          {formatNumber(limit)}
                          {overLimit ? " · 已满" : ` · ${basePct.toFixed(0)}%`}
                        </span>
                      </div>
                      <div className="relative h-1 w-full overflow-hidden rounded-full bg-secondary/80">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ease-apple ${
                            overLimit
                              ? "bg-gradient-to-r from-violet-500 to-fuchsia-500"
                              : basePct > 80
                                ? "bg-gradient-to-r from-amber-400 to-orange-500"
                                : "bg-gradient-to-r from-emerald-400 to-emerald-500"
                          }`}
                          style={{ width: `${basePct}%` }}
                        />
                      </div>
                    </div>

                    {/* 超额条（仅在已超额时出现，与基础额度清晰分离） */}
                    {overLimit && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[11px] tabular-nums">
                          <span className="flex items-center gap-1 font-medium text-violet-600 dark:text-violet-400">
                            <Zap className="h-3 w-3" />
                            超额用量
                          </span>
                          <span className="font-medium text-violet-600 dark:text-violet-400">
                            +${formatNumber(overageAmount)} / $
                            {formatNumber(OVERAGE_CAP)}
                            <span className="ml-1 text-muted-foreground">
                              {overagePct.toFixed(1)}%
                            </span>
                          </span>
                        </div>
                        <div className="relative h-1 w-full overflow-hidden rounded-full bg-violet-500/15">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500 ease-apple"
                            style={{ width: `${overagePct}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* 重置 */}
                    <div className="mt-auto flex items-center justify-between border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                      <span>额度重置</span>
                      <span
                        className="font-medium text-foreground"
                        title={formatResetDate(balance.nextResetAt)}
                      >
                        {formatResetShort(balance.nextResetAt)}
                      </span>
                    </div>
                  </div>
                );
                })()}
              </div>
            ) : loadingBalance ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在查询余额…
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-center text-[13px] text-muted-foreground">
                余额未查询，点击顶部"刷新当前页余额"即可加载。
              </div>
            )}
          </div>

          {/* 操作区：主操作（编辑）+ 图标按钮组（参考 AccountCard 的布局） */}
          <div className="mt-auto flex items-center gap-1 border-t border-border/50 pt-2.5">
            <Button
              ref={setActivatorNodeRef}
              size="icon"
              variant="ghost"
              data-no-rect-select
              className="h-8 w-8 shrink-0 cursor-grab touch-none active:cursor-grabbing"
              title="拖拽调整优先级"
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-4 w-4 text-muted-foreground" />
            </Button>

            {/* 主操作：编辑 */}
            <button
              type="button"
              onClick={() => setShowEditDialog(true)}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
            >
              <Pencil className="h-3.5 w-3.5" />
              编辑
            </button>

            {/* 次操作：图标按钮组 */}
            <div className="ml-0.5 flex items-center gap-0.5 border-l border-border/50 pl-1">
              <button
                type="button"
                onClick={handleForceRefresh}
                disabled={
                  forceRefresh.isPending ||
                  credential.disabled ||
                  credential.authMethod === "api_key"
                }
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-primary disabled:opacity-40"
                title={
                  credential.authMethod === "api_key"
                    ? "API Key 无需刷新"
                    : credential.disabled
                      ? "已禁用"
                      : "强制刷新 Token"
                }
              >
                <KeyRound
                  className={`h-4 w-4 ${forceRefresh.isPending ? "animate-spin" : ""}`}
                />
              </button>
              <button
                type="button"
                onClick={onRefreshBalance}
                disabled={loadingBalance || credential.disabled}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-primary disabled:opacity-40"
                title={credential.disabled ? "已禁用" : "刷新余额"}
              >
                <RefreshCw
                  className={`h-4 w-4 ${loadingBalance ? "animate-spin" : ""}`}
                />
              </button>
              <button
                type="button"
                onClick={() => setShowFailuresDialog(true)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="查看失败日志"
              >
                <ScrollText className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!credential.disabled) {
                    toast.error("请先禁用凭据再删除");
                    return;
                  }
                  setShowDeleteDialog(true);
                }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                title={
                  credential.disabled ? "删除凭据" : "请先禁用凭据再删除"
                }
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    title="更多操作"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      handleReset();
                    }}
                    disabled={
                      resetFailure.isPending ||
                      (credential.failureCount === 0 &&
                        credential.refreshFailureCount === 0)
                    }
                  >
                    <RotateCcw />
                    重置失败计数
                  </DropdownMenuItem>
	                  <DropdownMenuItem
	                    onSelect={() => setShowModelsDialog(true)}
                    disabled={credential.disabled}
                    title={
                      credential.disabled ? "已禁用凭据无法查询" : undefined
                    }
                  >
                    <Boxes />
	                    查看可用模型
	                  </DropdownMenuItem>
                  <div className="px-2 py-1.5">
                    <label className="mb-1 block text-xs text-muted-foreground">Endpoint</label>
                    <select
                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={endpointValue}
                      onChange={(event) => handleEndpointChange(event.target.value)}
                      disabled={setEndpoint.isPending}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <option value="">默认值（{globalConfig?.defaultEndpoint || "ide"}）</option>
                      {(globalConfig?.knownEndpoints?.length ? globalConfig.knownEndpoints : ["ide", "cli"]).map((endpoint) => (
                        <option key={endpoint} value={endpoint}>
                          {endpoint}
                        </option>
                      ))}
                    </select>
                  </div>
                  {throttleRemaining > 0 && (
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        handleClearThrottle();
                      }}
                      disabled={clearThrottle.isPending}
                    >
                      <Clock />
                      解除风控冷却（{formatThrottleCountdown(throttleRemaining)}
                      ）
                    </DropdownMenuItem>
                  )}
                  {credential.authMethod !== "api_key" && (
                    <DropdownMenuSeparator />
                  )}
                  {credential.authMethod !== "api_key" && (
                    <DropdownMenuItem
                      onSelect={() => setShowReloginDialog(true)}
                    >
                      <LogIn />
                      重新登录
                    </DropdownMenuItem>
                  )}
                  {credential.authMethod !== "api_key" && (
                    <DropdownMenuItem
                      onSelect={() => setShowUpdateTokenDialog(true)}
                    >
                      <RefreshCw />
                      重新导入 Token
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>确认删除凭据</DialogTitle>
            <DialogDescription>
              您确定要删除凭据 #{credential.id} 吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={deleteCredential.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteCredential.isPending || !credential.disabled}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EditCredentialDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        credential={credential}
      />
      <UpdateTokenDialog
        open={showUpdateTokenDialog}
        onOpenChange={setShowUpdateTokenDialog}
        credential={credential}
      />
      <ReloginDialog
        open={showReloginDialog}
        onOpenChange={setShowReloginDialog}
        credential={credential}
      />
      <CredentialFailuresDialog
        open={showFailuresDialog}
        onOpenChange={setShowFailuresDialog}
        credentialId={credential.id}
        email={
          privacyMode && credential.email
            ? maskEmail(credential.email)
            : credential.email
        }
      />
      <AvailableModelsDialog
        open={showModelsDialog}
        onOpenChange={setShowModelsDialog}
        credentialId={showModelsDialog ? credential.id : null}
      />
    </>
  );
}
