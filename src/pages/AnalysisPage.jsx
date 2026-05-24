import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  getProjectDetail,
  getProjectResults,
  listProjects,
  runAnalysis,
} from '../lib/xtjsApi'
import { formatDateTime } from '../utils/formatters'
import EmptyBlock from '../components/EmptyBlock'
import ProjectDropdown from '../components/ProjectDropdown'

const ANALYSIS_TYPES = [
  {
    key: 'businessBidDuplicateCheck',
    label: '商务标查重',
    icon: '📄',
    description: '仅对商务标文档之间进行内容查重',
    services: ['business_bid_duplicate_check'],
    requiredParsingStatus: 2,
  },
  {
    key: 'personnelReuseCheck',
    label: '人员复用',
    icon: '👥',
    description: '检测关键人员是否在不同标书中重复出现',
    services: ['personnel_reuse_check'],
    requiredParsingStatus: 2,
  },
  {
    key: 'technicalBidDuplicateCheck',
    label: '技术标查重',
    icon: '📐',
    description: '仅对技术标文档之间进行内容查重',
    services: ['technical_bid_duplicate_check'],
    requiredParsingStatus: 3,
  },
  {
    key: 'businessBidFormatReview',
    label: '形式审查',
    icon: '🔍',
    description: '检查商务标格式规范性与完整性',
    services: ['business_bid_format_review'],
    requiredParsingStatus: 2,
  },
  {
    key: 'typoCheck',
    label: '错字检查',
    icon: '✏️',
    description: '检查标书中的错别字与用词不当',
    services: ['typo_check'],
    requiredParsingStatus: 3,
  },
  {
    key: 'bidDocumentReview',
    label: '综合审查',
    icon: '📝',
    description: '一键执行全部审查项并汇总结果',
    services: [
      'business_bid_format_review',
      'business_bid_duplicate_check',
      'technical_bid_duplicate_check',
      'personnel_reuse_check',
      'typo_check',
    ],
    requiredParsingStatus: 3,
  },
]

/**
 * 将 /api/analysis.run 统一返回结果标准化为各卡片需要的格式。
 * 卡片依赖 result.summary.document_count (或 total) 和 result.summary.suspicious_* 字段。
 */
function normalizeAnalysisResult(analysisType, apiResult) {
  const results = apiResult?.results ?? {}
  const serviceKeys = analysisType.services

  // 单服务类型：直接提取该服务的 summary
  if (serviceKeys.length === 1) {
    const svcKey = serviceKeys[0]
    const svcResult = results[svcKey]

    if (!svcResult) {
      return { summary: { total: 0, suspicious: 0 } }
    }

    // 从各服务结果中提取 summary
    let documentCount = 0
    let suspiciousCount = 0

    if (svcKey === 'business_bid_format_review') {
      documentCount = svcResult.review?.summary?.bidder_count ?? svcResult.overview?.bidder_count ?? 0
      suspiciousCount = svcResult.review?.summary?.review_status_counts?.fail ?? 0
    } else if (svcKey === 'business_bid_duplicate_check' || svcKey === 'technical_bid_duplicate_check') {
      documentCount = svcResult.summary?.document_count ?? svcResult.groups?.[svcKey === 'business_bid_duplicate_check' ? 'business_bid' : 'technical_bid']?.summary?.document_count ?? 0
      suspiciousCount = svcResult.summary?.suspicious_pair_count ?? 0
    } else if (svcKey === 'personnel_reuse_check') {
      documentCount = svcResult.summary?.total ?? 0
      suspiciousCount = svcResult.summary?.suspicious ?? 0
    } else if (svcKey === 'typo_check') {
      documentCount = svcResult.summary?.document_count ?? 0
      suspiciousCount = svcResult.summary?.suspicious_typo_document_count ?? (svcResult.summary?.suspicious ? 1 : 0)
    }

    return {
      ...svcResult,
      summary: {
        ...svcResult.summary,
        document_count: documentCount,
        total: documentCount,
        suspicious: suspiciousCount,
        suspicious_pair_count: suspiciousCount,
        suspicious_document_count: suspiciousCount,
      },
    }
  }

  // 多服务类型（全文比对查重、综合审查）：合并各服务的 summary
  let totalDocuments = 0
  let totalSuspicious = 0

  for (const svcKey of serviceKeys) {
    const svcResult = results[svcKey]
    if (!svcResult) continue

    if (svcKey === 'business_bid_format_review') {
      totalDocuments += svcResult.review?.summary?.bidder_count ?? 0
      totalSuspicious += svcResult.review?.summary?.review_status_counts?.fail ?? 0
    } else if (svcKey === 'business_bid_duplicate_check' || svcKey === 'technical_bid_duplicate_check') {
      totalDocuments += svcResult.summary?.document_count ?? 0
      totalSuspicious += svcResult.summary?.suspicious_pair_count ?? 0
    } else if (svcKey === 'personnel_reuse_check') {
      totalDocuments += svcResult.summary?.total ?? 0
      totalSuspicious += svcResult.summary?.suspicious ?? 0
    } else if (svcKey === 'typo_check') {
      totalDocuments += svcResult.summary?.document_count ?? 0
      totalSuspicious += svcResult.summary?.suspicious_typo_document_count ?? 0
    }
  }

  return {
    ...apiResult,
    summary: {
      document_count: totalDocuments,
      total: totalDocuments,
      suspicious: totalSuspicious,
      suspicious_pair_count: totalSuspicious,
      suspicious_document_count: totalSuspicious,
    },
  }
}

function normalizeProjectResultsPayload(data) {
  const candidates = [
    data?.results,
    data?.result,
    data?.result_record?.result,
    data,
  ]

  return candidates.find((item) => item && typeof item === 'object' && !Array.isArray(item)) ?? {}
}

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
  const [checkedServices, setCheckedServices] = useState(new Set())
  const [selectedProjectParsingStatus, setSelectedProjectParsingStatus] = useState(0)

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
      const allResults = normalizeProjectResultsPayload(data)

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
    loadProjectResults(selectedProjectId)
  }, [selectedProjectId, loadProjectResults])


  function handleProjectChange(projectId) {
    setSelectedProjectId(projectId)
    setSearchParams(projectId ? { projectId } : {})
    setResults({})
    setAnalysisStatus({})
    setSelectedProjectParsingStatus(0)

    if (projectId) {
      getProjectDetail(projectId).then((detail) => {
        setSelectedProjectParsingStatus(detail.project?.parsing_status ?? 0)
      }).catch(() => {
        setSelectedProjectParsingStatus(0)
      })
    }
  }

  function isServiceDisabled(analysisType) {
    return selectedProjectParsingStatus < (analysisType.requiredParsingStatus ?? 0)
  }

  function toggleService(key) {
    const analysisType = ANALYSIS_TYPES.find((t) => t.key === key)
    if (!analysisType || isServiceDisabled(analysisType)) return

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
      const enabledTypes = ANALYSIS_TYPES.filter((t) => !isServiceDisabled(t))
      const enabledKeys = enabledTypes.map((t) => t.key)
      if (enabledKeys.every((k) => prev.has(k))) {
        return new Set()
      }
      return new Set(enabledKeys)
    })
  }

  async function handleBatchExecute() {
    if (!selectedProjectId || checkedServices.size === 0) return

    const keys = [...checkedServices]
    const typesToRun = ANALYSIS_TYPES.filter((t) => keys.includes(t.key))

    // 收集所有需要执行的服务（去重）
    const allServices = [...new Set(typesToRun.flatMap((t) => t.services))]

    // 标记所有选中类型为执行中
    for (const analysisType of typesToRun) {
      setAnalysisStatus((prev) => ({ ...prev, [analysisType.key]: 'running' }))
      addLog(analysisType.label, 'running')
    }

    try {
      const result = await runAnalysis({
        projectIdentifier: selectedProjectId,
        services: allServices,
      })

      // 一次调用返回所有结果，根据各类型需要的服务提取对应结果
      for (const analysisType of typesToRun) {
        const normalizedResult = normalizeAnalysisResult(analysisType, result)
        setAnalysisStatus((prev) => ({ ...prev, [analysisType.key]: 'success' }))
        setResults((prev) => ({ ...prev, [analysisType.key]: normalizedResult }))
        updateLog(analysisType.label, 'success')
      }
    } catch (error) {
      for (const analysisType of typesToRun) {
        setAnalysisStatus((prev) => ({ ...prev, [analysisType.key]: 'error' }))
        updateLog(analysisType.label, 'error')
      }
      setNotice({ type: 'error', message: `分析执行失败: ${error.message}` })
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
            checked={(() => {
              const enabledKeys = ANALYSIS_TYPES.filter((t) => !isServiceDisabled(t)).map((t) => t.key)
              return enabledKeys.length > 0 && enabledKeys.every((k) => checkedServices.has(k))
            })()}
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

      {(() => {
        const bidDocumentReview = ANALYSIS_TYPES.find((t) => t.key === 'bidDocumentReview')
        const businessGroup = ANALYSIS_TYPES.filter((t) => (t.requiredParsingStatus ?? 0) === 2)
        const technicalGroup = ANALYSIS_TYPES.filter((t) => (t.requiredParsingStatus ?? 0) === 3 && t.key !== 'bidDocumentReview')

        function renderCard(analysisType) {
          const status = analysisStatus[analysisType.key] ?? 'idle'
          const result = results[analysisType.key]
          const suspiciousCount = result?.summary?.suspicious_pair_count
            ?? result?.summary?.suspicious_document_count
            ?? result?.summary?.suspicious
            ?? 0
          const disabled = isServiceDisabled(analysisType)

          return (
            <div
              className={`panel analysis-card ${checkedServices.has(analysisType.key) ? 'analysis-card-checked' : ''} ${disabled ? 'analysis-card-disabled' : ''}`}
              key={analysisType.key}
            >
              <div className="analysis-card-head">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={checkedServices.has(analysisType.key)}
                    onChange={() => toggleService(analysisType.key)}
                    disabled={disabled}
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

              {disabled ? (
                <span className="analysis-card-hint">解析中，暂不可用</span>
              ) : null}

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
        }

        return (
          <>
            {businessGroup.length > 0 ? (
              <div className="analysis-group" key="business">
                <h3 className="analysis-group-title">商务标查重</h3>
                <div className="analysis-grid">
                  {businessGroup.map(renderCard)}
                </div>
              </div>
            ) : null}
            {technicalGroup.length > 0 ? (
              <div className="analysis-group" key="technical">
                <h3 className="analysis-group-title">技术标查重</h3>
                <div className="analysis-grid">
                  {technicalGroup.map(renderCard)}
                </div>
              </div>
            ) : null}
            {bidDocumentReview ? (
              <div className="analysis-group" key="review">
                <h3 className="analysis-group-title">综合审查</h3>
                <div className="analysis-grid">
                  {renderCard(bidDocumentReview)}
                </div>
              </div>
            ) : null}
          </>
        )
      })()}

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
