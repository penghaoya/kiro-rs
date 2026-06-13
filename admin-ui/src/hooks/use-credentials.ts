import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getCredentials,
  setCredentialDisabled,
  setCredentialPriority,
  setCredentialEndpoint,
  resetCredentialFailure,
  forceRefreshToken,
  clearThrottle,
  getCredentialBalance,
  getCredentialModels,
  addCredential,
  deleteCredential,
  updateCredential,
  updateRefreshToken,
  getLoadBalancingMode,
  setLoadBalancingMode,
  getRetryPolicy,
  setRetryPolicy,
  getAccountThrottleConfig,
  setAccountThrottleConfig,
  getLogGovernanceConfig,
  setLogGovernanceConfig,
  getGlobalConfig,
  updateGlobalConfig,
  resetSuccessCount,
  resetAllSuccessCount,
} from '@/api/credentials'
import type { AddCredentialRequest, UpdateCredentialRequest, UpdateGlobalConfigRequest, UpdateRefreshTokenRequest } from '@/types/api'
import type { CredentialsStatusResponse, CredentialStatusItem } from '@/types/api'

const CREDENTIALS_KEY = ['credentials'] as const

/**
 * 乐观更新单个凭据：在缓存里就地改写 id 命中的那条，立刻反映到 UI，
 * 避免等最长 30s 的整列表 refetch 造成开关回弹 / 整页闪烁。
 * 返回回滚所需的旧快照（配合 onError 使用）。
 */
function optimisticPatchCredential(
  queryClient: ReturnType<typeof useQueryClient>,
  id: number,
  patch: (c: CredentialStatusItem) => CredentialStatusItem,
) {
  const previous = queryClient.getQueryData<CredentialsStatusResponse>(CREDENTIALS_KEY)
  if (previous) {
    queryClient.setQueryData<CredentialsStatusResponse>(CREDENTIALS_KEY, {
      ...previous,
      credentials: previous.credentials.map((c) => (c.id === id ? patch(c) : c)),
    })
  }
  return { previous }
}

/** 乐观更新的统一 onError 回滚：把列表缓存还原成 onMutate 时的快照。 */
function rollbackCredentials(
  queryClient: ReturnType<typeof useQueryClient>,
  ctx: { previous?: CredentialsStatusResponse } | undefined,
) {
  if (ctx?.previous) queryClient.setQueryData(CREDENTIALS_KEY, ctx.previous)
}

// 查询凭据列表
export function useCredentials() {
  return useQuery({
    queryKey: ['credentials'],
    queryFn: getCredentials,
    refetchInterval: 30000, // 每 30 秒刷新一次
  })
}

// 查询凭据余额
export function useCredentialBalance(id: number | null) {
  return useQuery({
    queryKey: ['credential-balance', id],
    queryFn: () => getCredentialBalance(id!),
    enabled: id !== null,
    retry: false, // 余额查询失败时不重试（避免重复请求被封禁的账号）
  })
}

// 查询凭据当前可用的模型列表（按需实时查询上游）
export function useCredentialModels(id: number | null) {
  return useQuery({
    queryKey: ['credential-models', id],
    queryFn: () => getCredentialModels(id!),
    enabled: id !== null,
    retry: false, // 失败不重试，避免对被封禁/异常账号反复请求
  })
}

// 设置禁用状态
export function useSetDisabled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, disabled }: { id: number; disabled: boolean }) =>
      setCredentialDisabled(id, disabled),
    onMutate: async ({ id, disabled }) => {
      await queryClient.cancelQueries({ queryKey: CREDENTIALS_KEY })
      return optimisticPatchCredential(queryClient, id, (c) => ({ ...c, disabled }))
    },
    onError: (_e, _v, ctx) => rollbackCredentials(queryClient, ctx),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY }),
  })
}

// 设置优先级
export function useSetPriority() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, priority }: { id: number; priority: number }) =>
      setCredentialPriority(id, priority),
    onMutate: async ({ id, priority }) => {
      await queryClient.cancelQueries({ queryKey: CREDENTIALS_KEY })
      return optimisticPatchCredential(queryClient, id, (c) => ({ ...c, priority }))
    },
    onError: (_e, _v, ctx) => rollbackCredentials(queryClient, ctx),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY }),
  })
}

// 设置 endpoint
export function useSetEndpoint() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, endpoint }: { id: number; endpoint: string | null }) =>
      setCredentialEndpoint(id, endpoint),
    onMutate: async ({ id, endpoint }) => {
      await queryClient.cancelQueries({ queryKey: CREDENTIALS_KEY })
      return optimisticPatchCredential(queryClient, id, (c) => ({
        ...c,
        configuredEndpoint: endpoint,
      }))
    },
    onError: (_e, _v, ctx) => rollbackCredentials(queryClient, ctx),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY })
      queryClient.invalidateQueries({ queryKey: ['globalConfig'] })
    },
  })
}

// 重置失败计数
export function useResetFailure() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => resetCredentialFailure(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: CREDENTIALS_KEY })
      return optimisticPatchCredential(queryClient, id, (c) => ({ ...c, failureCount: 0 }))
    },
    onError: (_e, _v, ctx) => rollbackCredentials(queryClient, ctx),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY }),
  })
}

// 强制刷新 Token
export function useForceRefreshToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => forceRefreshToken(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    },
  })
}

// 解除账号级风控冷却
export function useClearThrottle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => clearThrottle(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: CREDENTIALS_KEY })
      return optimisticPatchCredential(queryClient, id, (c) => ({
        ...c,
        throttledRemainingSecs: 0,
      }))
    },
    onError: (_e, _v, ctx) => rollbackCredentials(queryClient, ctx),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY }),
  })
}

// 添加新凭据
export function useAddCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: AddCredentialRequest) => addCredential(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    },
  })
}

// 删除凭据
export function useDeleteCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteCredential(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    },
  })
}

// 重置单个凭据的成功次数
export function useResetSuccessCount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => resetSuccessCount(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    },
  })
}

// 重置所有凭据的成功次数
export function useResetAllSuccessCount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => resetAllSuccessCount(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    },
  })
}

// 更新已禁用凭据的 refreshToken
export function useUpdateRefreshToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, req }: { id: number; req: UpdateRefreshTokenRequest }) =>
      updateRefreshToken(id, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    },
  })
}

// 更新凭据可编辑字段
export function useUpdateCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, req }: { id: number; req: UpdateCredentialRequest }) =>
      updateCredential(id, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    },
  })
}

// 获取负载均衡模式
export function useLoadBalancingMode() {
  return useQuery({
    queryKey: ['loadBalancingMode'],
    queryFn: getLoadBalancingMode,
  })
}

// 设置负载均衡模式
export function useSetLoadBalancingMode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: setLoadBalancingMode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['loadBalancingMode'] })
    },
  })
}

// 获取普通 429 重试策略
export function useRetryPolicy() {
  return useQuery({
    queryKey: ['retryPolicy'],
    queryFn: getRetryPolicy,
  })
}

// 设置普通 429 重试策略
export function useSetRetryPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: setRetryPolicy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['retryPolicy'] })
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    },
  })
}

// 获取账号级风控故障转移配置
export function useAccountThrottleConfig() {
  return useQuery({
    queryKey: ['accountThrottleConfig'],
    queryFn: getAccountThrottleConfig,
  })
}

// 更新账号级风控故障转移配置
export function useSetAccountThrottleConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: setAccountThrottleConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accountThrottleConfig'] })
    },
  })
}

// 获取日志治理配置
export function useLogGovernanceConfig() {
  return useQuery({
    queryKey: ['logGovernanceConfig'],
    queryFn: getLogGovernanceConfig,
  })
}

// 更新日志治理配置
export function useSetLogGovernanceConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: setLogGovernanceConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['logGovernanceConfig'] })
    },
  })
}

// 获取全局配置
export function useGlobalConfig() {
  return useQuery({
    queryKey: ['globalConfig'],
    queryFn: getGlobalConfig,
  })
}

// 更新全局配置
export function useUpdateGlobalConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: UpdateGlobalConfigRequest) => updateGlobalConfig(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['globalConfig'] })
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
      queryClient.invalidateQueries({ queryKey: ['logGovernanceConfig'] })
    },
  })
}
