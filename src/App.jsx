import { useCallback, useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import './App.css'
import { probeBackend } from './lib/xtjsApi'
import ProjectsPage from './pages/ProjectsPage'
import AnalysisPage from './pages/AnalysisPage'
import ReviewPage from './pages/ReviewPage'

const NAV_TABS = [
  { path: '/projects', label: '项目管理' },
  { path: '/analysis', label: '分析中心' },
  { path: '/review', label: '结果审核' },
]

function TopBar({ connection, onRefresh, isRefreshing }) {
  const location = useLocation()

  return (
    <header className="topbar">
      <div className="topbar-left">
        <h1>信投建设智能申标平台</h1>
        <nav className="nav-tabs">
          {NAV_TABS.map((tab) => (
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
      </div>
    </header>
  )
}

export default function App() {
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
    <HashRouter>
      <div className="app-shell">
        <TopBar connection={connection} onRefresh={checkConnection} isRefreshing={isRefreshing} />

        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/analysis" element={<AnalysisPage />} />
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </div>
    </HashRouter>
  )
}
