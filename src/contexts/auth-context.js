import { createContext, useContext } from 'react'

// 权限等级常量，供按级显隐复用。
export const ROLE_LEVEL = {
  NORMAL: 1, // 普通用户
  INTERMEDIATE: 2, // 中级用户
  SENIOR: 3, // 高级用户
  ADMIN: 4, // 管理员
}

export const AuthContext = createContext(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth 必须在 AuthProvider 内使用')
  }
  return ctx
}
