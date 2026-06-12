import { useCallback, useEffect, useState } from 'react'

const THEME_STORAGE_KEY = 'kiro-admin-theme'

/** 读取持久化的主题偏好；无存储值时回退到系统偏好。 */
function getPreferredDark(): boolean {
  if (typeof window === 'undefined') return false
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  if (stored === 'dark') return true
  if (stored === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/** 把暗色状态同步到 <html> 的 class 与 localStorage。 */
function applyDark(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark)
  localStorage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light')
}

/**
 * 全局暗色模式：单一数据源。
 * - 初始值取持久化偏好（无则跟随系统）
 * - 状态变化时写回 DOM class 与 localStorage
 * - 跨标签页通过 storage 事件同步
 */
export function useDarkMode(): { darkMode: boolean; toggle: () => void } {
  const [darkMode, setDarkMode] = useState(getPreferredDark)

  useEffect(() => {
    applyDark(darkMode)
  }, [darkMode])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY && e.newValue) {
        setDarkMode(e.newValue === 'dark')
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const toggle = useCallback(() => setDarkMode((v) => !v), [])

  return { darkMode, toggle }
}
