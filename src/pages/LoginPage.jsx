import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/auth-context'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 登录成功后回跳到来源页（被守卫拦截前的目标），默认进项目管理。
  const redirectTo = location.state?.from?.pathname || '/projects'

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (submitting) return
    setError('')
    if (!username.trim() || !password) {
      setError('请输入用户名和密码')
      return
    }
    setSubmitting(true)
    try {
      await login(username.trim(), password)
      navigate(redirectTo, { replace: true })
    } catch (err) {
      setError(err?.message || '登录失败，请稍后再试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card panel" onSubmit={handleSubmit}>
        <div className="login-head">
          <h1>信投建设智能审标平台</h1>
          <p>请登录以继续</p>
        </div>

        <label className="field field-wide">
          <span>用户名</span>
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="请输入用户名"
            autoFocus
          />
        </label>

        <label className="field field-wide">
          <span>密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入密码"
          />
        </label>

        {error ? <p className="login-error">{error}</p> : null}

        <button type="submit" className="primary-button login-submit" disabled={submitting}>
          {submitting ? '登录中...' : '登录'}
        </button>

        <p className="login-hint">账号由管理员统一创建分配，如需账号请联系管理员。</p>
      </form>
    </div>
  )
}
