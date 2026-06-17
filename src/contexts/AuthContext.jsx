import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AUTH_UNAUTHORIZED_EVENT,
  clearToken,
  getToken,
} from '../lib/xtjsApi'
import { fetchMe, login as loginRequest, logout as logoutRequest } from '../lib/authApi'
import { AuthContext, ROLE_LEVEL } from './auth-context'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  // 启动时若本地有令牌，需先校验再决定是否已登录。
  const [initializing, setInitializing] = useState(() => Boolean(getToken()))

  // 启动校验：有 token 则拉取当前用户，失败则视为未登录。
  useEffect(() => {
    let cancelled = false
    if (!getToken()) {
      setInitializing(false)
      return undefined
    }
    fetchMe()
      .then((me) => {
        if (!cancelled) setUser(me)
      })
      .catch(() => {
        if (!cancelled) {
          clearToken()
          setUser(null)
        }
      })
      .finally(() => {
        if (!cancelled) setInitializing(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 监听 API 层派发的 401 事件，统一登出。
  useEffect(() => {
    const handler = () => setUser(null)
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handler)
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handler)
  }, [])

  const login = useCallback(async (username, password) => {
    const data = await loginRequest(username, password)
    // 登录返回的用户信息字段与 /me 对齐使用。
    setUser(data?.user ?? null)
    return data
  }, [])

  const logout = useCallback(() => {
    logoutRequest()
    setUser(null)
  }, [])

  const hasLevel = useCallback(
    (minLevel) => Boolean(user) && Number(user.role_level) >= Number(minLevel),
    [user],
  )

  const value = useMemo(
    () => ({
      user,
      isAuthenticated: Boolean(user),
      initializing,
      login,
      logout,
      hasLevel,
      isAdmin: Boolean(user) && Number(user.role_level) >= ROLE_LEVEL.ADMIN,
    }),
    [user, initializing, login, logout, hasLevel],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
