import { useCallback, useEffect, useState } from 'react'
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import './App.css'
import { probeBackend } from './lib/xtjsApi'
import { AuthProvider } from './contexts/AuthContext'
import { ROLE_LEVEL, useAuth } from './contexts/auth-context'
import ProjectsPage from './pages/ProjectsPage'
import AnalysisPage from './pages/AnalysisPage'
import ReviewPage from './pages/ReviewPage'
import LoginPage from './pages/LoginPage'
import UsersPage from './pages/UsersPage'

const NAV_TABS = [
  { path: '/projects', label: '项目管理' },
  { path: '/analysis', label: '分析中心' },
  { path: '/review', label: '结果审核' },
  { path: '/users', label: '用户管理', minLevel: ROLE_LEVEL.ADMIN },
]

// 路由守卫：未登录跳登录页；可选按等级守卫，等级不足回项目首页。
function RequireAuth({ minLevel, children }) {
  const { isAuthenticated, initializing, hasLevel } = useAuth()
  const location = useLocation()

  if (initializing) {
    return <div className="app-loading">正在校验登录状态...</div>
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  if (minLevel && !hasLevel(minLevel)) {
    return <Navigate to="/projects" replace />
  }
  return children
}

function TopBar({ connection, onRefresh, isRefreshing }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout, hasLevel } = useAuth()

  const visibleTabs = NAV_TABS.filter((tab) => !tab.minLevel || hasLevel(tab.minLevel))

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <h1>信投建设智能审标平台</h1>
        <nav className="nav-tabs">
          {visibleTabs.map((tab) => (
            <a
              key={tab.path}
              href={`#${tab.path}`}
              className={`nav-tab ${location.pathname === tab.path ? 'nav-tab-active' : ''}`}
            >
              {tab.label}
            </a>
          ))}
        </nav>
      </div>
      <div className="topbar-actions">
        <span className={`connection-badge ${connection.status}`}>{connection.message}</span>
        <button
          type="button"
          className="ghost-button"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          {isRefreshing ? '刷新中...' : '刷新'}
        </button>
        {user ? (
          <div className="user-menu">
            <span className="user-chip" title={user.username}>
              {user.display_name || user.username}
              <em className="user-role">{user.role_label}</em>
            </span>
            <button type="button" className="ghost-button" onClick={handleLogout}>
              退出登录
            </button>
          </div>
        ) : null}
      </div>
    </header>
  )
}

// 已登录后的主框架（顶栏 + 业务路由）。
function AppShell() {
  const [connection, setConnection] = useState({
    status: 'loading',
    message: '正在连接接口',
  })
  const [isRefreshing, setIsRefreshing] = useState(false)

  const checkConnection = useCallback(async () => {
    setIsRefreshing(true)
    try {
      await probeBackend()
      setConnection({ status: 'success', message: 'API 已连接' })
    } catch {
      setConnection({ status: 'error', message: 'API 连接失败' })
    } finally {
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    checkConnection()
  }, [checkConnection])

  return (
    <div className="app-shell">
      <TopBar connection={connection} onRefresh={checkConnection} isRefreshing={isRefreshing} />

      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/analysis" element={<AnalysisPage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route
          path="/users"
          element={(
            <RequireAuth minLevel={ROLE_LEVEL.ADMIN}>
              <UsersPage />
            </RequireAuth>
          )}
        />
      </Routes>
    </div>
  )
}

export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/*"
            element={(
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            )}
          />
        </Routes>
      </AuthProvider>
    </HashRouter>
  )
}
