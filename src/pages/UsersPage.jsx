import { useCallback, useEffect, useState } from 'react'
import { useAuth, ROLE_LEVEL } from '../contexts/auth-context'
import {
  createUser,
  deleteUser,
  listUsers,
  resetUserPassword,
  updateUser,
} from '../lib/authApi'

const ROLE_OPTIONS = [
  { value: ROLE_LEVEL.NORMAL, label: '普通用户' },
  { value: ROLE_LEVEL.INTERMEDIATE, label: '中级用户' },
  { value: ROLE_LEVEL.SENIOR, label: '高级用户' },
  { value: ROLE_LEVEL.ADMIN, label: '管理员' },
]

const EMPTY_FORM = { username: '', password: '', roleLevel: ROLE_LEVEL.NORMAL, displayName: '' }

export default function UsersPage() {
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState(EMPTY_FORM)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setUsers(await listUsers())
    } catch (err) {
      setError(err?.message || '加载用户列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const flash = (message) => {
    setNotice(message)
    setError('')
    window.clearTimeout(flash._timer)
    flash._timer = window.setTimeout(() => setNotice(''), 3000)
  }

  const handleCreate = async (event) => {
    event.preventDefault()
    if (creating) return
    if (!form.username.trim() || !form.password) {
      setError('请填写用户名和初始密码')
      return
    }
    setCreating(true)
    setError('')
    try {
      await createUser({
        username: form.username.trim(),
        password: form.password,
        roleLevel: Number(form.roleLevel),
        displayName: form.displayName.trim(),
      })
      setForm(EMPTY_FORM)
      flash('用户创建成功')
      await refresh()
    } catch (err) {
      setError(err?.message || '创建用户失败')
    } finally {
      setCreating(false)
    }
  }

  const handleRoleChange = async (target, roleLevel) => {
    setError('')
    try {
      await updateUser(target.identifier_id, { roleLevel: Number(roleLevel) })
      flash('已更新权限等级')
      await refresh()
    } catch (err) {
      setError(err?.message || '更新权限失败')
      await refresh()
    }
  }

  const handleToggleActive = async (target) => {
    setError('')
    try {
      await updateUser(target.identifier_id, { isActive: !target.is_active })
      flash(target.is_active ? '已停用账号' : '已启用账号')
      await refresh()
    } catch (err) {
      setError(err?.message || '操作失败')
    }
  }

  const handleResetPassword = async (target) => {
    const next = window.prompt(`为「${target.username}」设置新密码（至少8位，含字母和数字）：`)
    if (next === null) return
    setError('')
    try {
      await resetUserPassword(target.identifier_id, next)
      flash('密码已重置')
    } catch (err) {
      setError(err?.message || '重置密码失败')
    }
  }

  const handleDelete = async (target) => {
    if (!window.confirm(`确认删除用户「${target.username}」？该操作不可撤销。`)) return
    setError('')
    try {
      await deleteUser(target.identifier_id)
      flash('用户已删除')
      await refresh()
    } catch (err) {
      setError(err?.message || '删除失败')
    }
  }

  return (
    <main className="page users-page">
      <section className="create-panel panel">
        <div className="panel-header">
          <h2>新建用户</h2>
        </div>
        <form className="create-grid" onSubmit={handleCreate}>
          <label className="field">
            <span>用户名</span>
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="登录用户名"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>初始密码</span>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="至少8位，含字母和数字"
              autoComplete="new-password"
            />
          </label>
          <label className="field">
            <span>权限等级</span>
            <select
              value={form.roleLevel}
              onChange={(e) => setForm({ ...form, roleLevel: Number(e.target.value) })}
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>展示名称（可选）</span>
            <input
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              placeholder="如：张三"
              autoComplete="off"
            />
          </label>
          <div className="field-wide users-create-actions">
            <button type="submit" className="primary-button" disabled={creating}>
              {creating ? '创建中...' : '创建用户'}
            </button>
          </div>
        </form>
      </section>

      {error ? <p className="login-error">{error}</p> : null}
      {notice ? <p className="users-notice">{notice}</p> : null}

      <section className="result-panel panel">
        <div className="panel-header">
          <h2>用户列表</h2>
          <button type="button" className="ghost-button" onClick={refresh} disabled={loading}>
            {loading ? '加载中...' : '刷新'}
          </button>
        </div>

        {loading ? (
          <p className="users-empty">加载中...</p>
        ) : users.length === 0 ? (
          <p className="users-empty">暂无用户</p>
        ) : (
          <div className="users-table-wrap">
            <table className="users-table">
              <thead>
                <tr>
                  <th>用户名</th>
                  <th>展示名</th>
                  <th>权限等级</th>
                  <th>状态</th>
                  <th>最近登录</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = currentUser?.identifier_id === u.identifier_id
                  return (
                    <tr key={u.identifier_id}>
                      <td>
                        {u.username}
                        {isSelf ? <span className="users-self-tag">（我）</span> : null}
                      </td>
                      <td>{u.display_name || '-'}</td>
                      <td>
                        <select
                          value={u.role_level}
                          disabled={isSelf}
                          onChange={(e) => handleRoleChange(u, e.target.value)}
                        >
                          {ROLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span className={`users-status ${u.is_active ? 'active' : 'inactive'}`}>
                          {u.is_active ? '启用' : '停用'}
                        </span>
                      </td>
                      <td>{u.last_login_at ? String(u.last_login_at).replace('T', ' ').slice(0, 19) : '-'}</td>
                      <td className="users-actions">
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={isSelf}
                          onClick={() => handleToggleActive(u)}
                        >
                          {u.is_active ? '停用' : '启用'}
                        </button>
                        <button type="button" className="ghost-button" onClick={() => handleResetPassword(u)}>
                          重置密码
                        </button>
                        <button
                          type="button"
                          className="ghost-button users-danger"
                          disabled={isSelf}
                          onClick={() => handleDelete(u)}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}
