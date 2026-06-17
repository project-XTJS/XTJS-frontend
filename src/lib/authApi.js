// 认证与用户管理 API 封装。
// 复用 xtjsApi 的 token 注入与统一响应解包；管理员接口需 role_level=4。

import { request, setToken, clearToken } from './xtjsApi'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

// ─── 认证 ────────────────────────────────────────────

// 登录成功后写入令牌并返回用户信息。
export async function login(username, password) {
  const data = await request('/api/auth/login', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password }),
  })
  if (data?.access_token) {
    setToken(data.access_token)
  }
  return data
}

// 清除本地令牌（无服务端会话，登出即清 token）。
export function logout() {
  clearToken()
}

// 拉取当前登录用户信息（令牌校验）。
export async function fetchMe() {
  return request('/api/auth/me')
}

// 修改本人密码。
export async function changePassword(oldPassword, newPassword) {
  return request('/api/auth/change-password', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  })
}

// ─── 管理员：用户管理 ────────────────────────────────

export async function listUsers() {
  return request('/api/auth/users')
}

export async function createUser({ username, password, roleLevel, displayName }) {
  return request('/api/auth/users', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      username,
      password,
      role_level: roleLevel,
      display_name: displayName || null,
    }),
  })
}

export async function updateUser(identifierId, { roleLevel, isActive, displayName } = {}) {
  const body = {}
  if (roleLevel !== undefined) body.role_level = roleLevel
  if (isActive !== undefined) body.is_active = isActive
  if (displayName !== undefined) body.display_name = displayName
  return request(`/api/auth/users/${encodeURIComponent(identifierId)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
}

export async function resetUserPassword(identifierId, newPassword) {
  return request(`/api/auth/users/${encodeURIComponent(identifierId)}/reset-password`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ new_password: newPassword }),
  })
}

export async function deleteUser(identifierId) {
  return request(`/api/auth/users/${encodeURIComponent(identifierId)}`, {
    method: 'DELETE',
  })
}
