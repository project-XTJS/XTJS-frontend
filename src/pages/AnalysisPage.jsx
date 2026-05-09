import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  getProjectResults,
  listProjects,
  runBidDocumentReview,
  runBusinessBidDuplicateCheck,
  runBusinessBidFormatReview,
  runDuplicateCheck,
  runPersonnelReuseCheck,
  runTechnicalBidDuplicateCheck,
  runTypoCheck,
} from '../lib/xtjsApi'
import { formatDateTime } from '../utils/formatters'
import EmptyBlock from '../components/EmptyBlock'
import ProjectDropdown from '../components/ProjectDropdown'

const ANALYSIS_TYPES = [
  {
    key: 'duplicateCheck',
    label: '全文比对查重',
    icon: '📋',
    description: '比对商务标与技术标文档，发现高度相似的文本块',
    execute: (id) => runDuplicateCheck({ identifierId: id, documentScope: 'all' }),
    scopeEnabled: true,
  },
  {
    key: 'businessBidDuplicateCheck',
    label: '商务标查重',
    icon: '📄',
    description: '仅对商务标文档之间进行内容查重',
    execute: (id) => runBusinessBidDuplicateCheck({ identifierId: id }),
    scopeEnabled: false,
  },
  {
    key: 'technicalBidDuplicateCheck',
    label: '技术标查重',
    icon: '📐',
    description: '仅对技术标文档之间进行内容查重',
    execute: (id) => runTechnicalBidDuplicateCheck({ identifierId: id }),
    scopeEnabled: false,
  },
  {
    key: 'businessBidFormatReview',
    label: '形式审查',
    icon: '🔍',
    description: '检查商务标格式规范性与完整性',
    execute: (id) => runBusinessBidFormatReview(id),
    scopeEnabled: false,
  },
  {
    key: 'personnelReuseCheck',
    label: '人员复用',
    icon: '👥',
    description: '检测关键人员是否在不同标书中重复出现',
    execute: (id) => runPersonnelReuseCheck(id),
    scopeEnabled: false,
  },
  {
    key: 'typoCheck',
    label: '错字检查',
    icon: '✏️',
    description: '检查标书中的错别字与用词不当',
    execute: (id) => runTypoCheck(id),
    scopeEnabled: false,
  },
  {
    key: 'bidDocumentReview',
    label: '综合审查',
    icon: '📝',
    description: '一键执行全部审查项并汇总结果',
    execute: (id) => runBidDocumentReview({ identifierId: id, documentScope: 'all' }),
    scopeEnabled: true,
  },
]

function getAnalysisStatusIcon(status) {
  switch (status) {
    case 'running':
      return '⏳'
    case 'success':
      return '✅'
    case 'error':
      return '❌'
    default:
      return null
  }
}

export default function AnalysisPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [projects, setProjects] = useState([])
  const [selectedProjectId, setSelectedProjectId] = useState(searchParams.get('projectId') ?? '')
  const [results, setResults] = useState({})
  const [analysisStatus, setAnalysisStatus] = useState({})
  const [executionLog, setExecutionLog] = useState([])
  const [notice, setNotice] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [checkedServices, setCheckedServices] = useState(new Set())

  const loadProjects = useCallback(async () => {
    try {
      const listing = await listProjects({ pageSize: 100 })
      setProjects(listing.items ?? [])
    } catch {
      setNotice({ type: 'error', message: '项目列表加载失败' })
    }
  }, [])

  const loadProjectResults = useCallback(async (projectId) => {
    if (!projectId) return

    try {
      const data = await getProjectResults(projectId)
      const allResults = data.results ?? {}

      const statusMap = {}
      Object.keys(allResults).forEach((key) => {
        if (allResults[key]) {
          statusMap[key] = 'success'
        }
      })

      setResults(allResults)
      setAnalysisStatus((prev) => ({
        ...prev,
        ...statusMap,
      }))
    } catch {
      // project may have no results yet
    }
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    setIsLoading(true)
    loadProjectResults(selectedProjectId).finally(() => setIsLoading(false))
  }, [selectedProjectId, loadProjectResults])


  function handleProjectChange(projectId) {
    setSelectedProjectId(projectId)
    setSearchParams(projectId ? { projectId } : {})
    setResults({})
    setAnalysisStatus({})
  }

  function toggleService(key) {
    setCheckedServices((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  function toggleAllServices() {
    setCheckedServices((prev) => {
      if (prev.size === ANALYSIS_TYPES.length) {
        return new Set()
      }
      return new Set(ANALYSIS_TYPES.map((t) => t.key))
    })
  }

  async function handleBatchExecute() {
    if (!selectedProjectId || checkedServices.size === 0) return

    const keys = [...checkedServices]
    const typesToRun = ANALYSIS_TYPES.filter((t) => keys.includes(t.key))

    for (const analysisType of typesToRun) {
      const key = analysisType.key
      setAnalysisStatus((prev) => ({ ...prev, [key]: 'running' }))

      const startTime = new Date()
      addLog(analysisType.label, 'running')

      try {
        const result = await analysisType.execute(selectedProjectId)
        setAnalysisStatus((prev) => ({ ...prev, [key]: 'success' }))
        setResults((prev) => ({ ...prev, [key]: result }))
        updateLog(analysisType.label, 'success')
      } catch (error) {
        setAnalysisStatus((prev) => ({ ...prev, [key]: 'error' }))
        setNotice({ type: 'error', message: `${analysisType.label}失败: ${error.message}` })
        updateLog(analysisType.label, 'error')
      }
    }
  }

  function addLog(type, status) {
    setExecutionLog((prev) => [
      {
        id: Date.now() + Math.random(),
        time: new Date(),
        type,
        status,
      },
      ...prev.slice(0, 9),
    ])
  }

  function updateLog(type, status) {
    setExecutionLog((prev) =>
      prev.map((entry) =>
        entry.type === type && entry.status === 'running'
          ? { ...entry, status }
          : entry,
      ),
    )
  }

  const isRunning = Object.values(analysisStatus).some((s) => s === 'running')

  return (
    <>
      {notice ? (
        <div className={`notice notice-${notice.type}`}>
          <p>{notice.message}</p>
        </div>
      ) : null}

      <section className="analysis-header">
        <h2>分析中心</h2>

        <ProjectDropdown
          projects={projects}
          selectedProjectId={selectedProjectId}
          onChange={handleProjectChange}
        />
      </section>

      <section className="analysis-toolbar">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={checkedServices.size === ANALYSIS_TYPES.length}
            onChange={toggleAllServices}
          />
          <span>全选</span>
        </label>
        <span className="toolbar-count">已选 {checkedServices.size} 项</span>
        <button
          type="button"
          className="primary-button"
          onClick={handleBatchExecute}
          disabled={!selectedProjectId || checkedServices.size === 0 || isRunning}
        >
          {isRunning ? '执行中...' : '执行选中服务'}
        </button>
      </section>

      <section className="analysis-grid">
        {ANALYSIS_TYPES.map((analysisType) => {
          const status = analysisStatus[analysisType.key] ?? 'idle'
          const result = results[analysisType.key]
          const suspiciousCount = result?.summary?.suspicious_pair_count
            ?? result?.summary?.suspicious_document_count
            ?? result?.summary?.suspicious
            ?? 0

          return (
            <div className={`panel analysis-card ${checkedServices.has(analysisType.key) ? 'analysis-card-checked' : ''}`} key={analysisType.key}>
              <div className="analysis-card-head">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={checkedServices.has(analysisType.key)}
                    onChange={() => toggleService(analysisType.key)}
                  />
                </label>
                <span className="analysis-card-icon">{analysisType.icon}</span>
                <div>
                  <strong>{analysisType.label}</strong>
                  {getAnalysisStatusIcon(status) ? (
                    <span className="analysis-status-icon">
                      {getAnalysisStatusIcon(status)}
                    </span>
                  ) : null}
                </div>
              </div>

              <p>{analysisType.description}</p>

              {status === 'success' && result ? (
                <div className="analysis-card-result">
                  <span>
                    共检查 {result.summary?.document_count ?? result.summary?.total ?? '--'} 份文档
                  </span>
                  {suspiciousCount > 0 ? (
                    <span className="analysis-suspicious">发现 {suspiciousCount} 个可疑项</span>
                  ) : (
                    <span className="analysis-clean">未发现可疑项</span>
                  )}
                </div>
              ) : null}

              {status === 'success' && selectedProjectId ? (
                <div className="analysis-card-actions">
                  <a
                    href={`#/review?projectId=${selectedProjectId}`}
                    className="ghost-button"
                  >
                    查看结果 →
                  </a>
                </div>
              ) : null}
            </div>
          )
        })}
      </section>

      {!selectedProjectId ? (
        <section className="panel empty-panel">
          <EmptyBlock title="请先选择一个项目再执行分析" />
        </section>
      ) : null}

      <section className="panel execution-log">
        <div className="panel-header">
          <h2>执行记录</h2>
        </div>

        {executionLog.length > 0 ? (
          <table className="log-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>分析类型</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {executionLog.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDateTime(entry.time)}</td>
                  <td>{entry.type}</td>
                  <td>
                    {entry.status === 'running' ? '⏳ 执行中' : entry.status === 'success' ? '✅ 完成' : '❌ 失败'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyBlock title="暂无执行记录" />
        )}
      </section>
    </>
  )
}
