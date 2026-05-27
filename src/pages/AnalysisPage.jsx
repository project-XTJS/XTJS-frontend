import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  getProjectDetail,
  getProjectResults,
  listProjects,
  runAnalysis,
} from '../lib/xtjsApi'
import { formatDateTime } from '../utils/formatters'
import { normalizeProjectResultsPayload } from '../utils/results'
import EmptyBlock from '../components/EmptyBlock'
import ProjectDropdown from '../components/ProjectDropdown'

const PARSING_STATUS_BUSINESS_READY = 2
const PARSING_STATUS_TECHNICAL_READY = 3

const ANALYSIS_TYPES = [
  {
    key: 'businessBidDuplicateCheck',
    label: '商务标查重',
    icon: '📄',
    description: '仅对商务标文档之间进行内容查重',
    services: ['business_bid_duplicate_check'],
    requiredParsingStatus: PARSING_STATUS_BUSINESS_READY,
  },
  {
    key: 'personnelReuseCheck',
    label: '人员复用',
    icon: '👥',
    description: '检测关键人员是否在不同标书中重复出现',
    services: ['personnel_reuse_check'],
    requiredParsingStatus: PARSING_STATUS_BUSINESS_READY,
  },
  {
    key: 'technicalBidDuplicateCheck',
    label: '技术标查重',
    icon: '📐',
    description: '仅对技术标文档之间进行内容查重',
    services: ['technical_bid_duplicate_check'],
    requiredParsingStatus: PARSING_STATUS_TECHNICAL_READY,
  },
  {
    key: 'businessBidFormatReview',
    label: '形式审查',
    icon: '🔍',
    description: '检查商务标格式规范性与完整性',
    services: ['business_bid_format_review'],
    requiredParsingStatus: PARSING_STATUS_BUSINESS_READY,
  },
  {
    key: 'typoCheck',
    label: '错字检查',
    icon: '✏️',
    description: '检查标书中的错别字与用词不当',
    services: ['typo_check'],
    requiredParsingStatus: PARSING_STATUS_TECHNICAL_READY,
  },
]

function arrayify(value) {
  return Array.isArray(value) ? value : []
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function objectValues(value) {
  return isPlainObject(value) ? Object.values(value) : []
}

function collectionSize(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return 0
}

function normalizeCount(value) {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? count : null
}

function firstAvailableCount(...values) {
  let zeroFallback = null

  for (const value of values) {
    const count = normalizeCount(value)
    if (count === null) continue
    if (count > 0) return count
    if (zeroFallback === null) zeroFallback = count
  }

  return zeroFallback ?? 0
}

function getProjectIdentifier(project) {
  return project?.identifier_id || project?.identifierId || project?.id || project?.project_name || project?.projectName || ''
}

function getProjectName(project) {
  return project?.project_name || project?.projectName || project?.title || ''
}

function countRelationDocuments(relations, identifierKeys) {
  const ids = new Set()

  arrayify(relations).forEach((relation) => {
    identifierKeys.forEach((key) => {
      const id = relation?.[key]
      if (id) ids.add(String(id))
    })
  })

  return ids.size
}

function buildProjectMeta(project, relations = []) {
  if (!isPlainObject(project)) return null

  const normalizedRelations = arrayify(relations)

  const tenderCount = firstAvailableCount(
    project.tender_count,
    countRelationDocuments(normalizedRelations, ['tender_identifier_id', 'tender_document_identifier_id']),
  )
  const businessCount = firstAvailableCount(
    project.business_bid_count,
    countRelationDocuments(normalizedRelations, ['business_bid_identifier_id', 'business_bid_document_identifier_id']),
  )
  const technicalCount = firstAvailableCount(
    project.technical_bid_count,
    countRelationDocuments(normalizedRelations, ['technical_bid_identifier_id', 'technical_bid_document_identifier_id']),
  )

  return {
    ...project,
    relations: normalizedRelations,
    tender_count: tenderCount,
    business_bid_count: businessCount,
    technical_bid_count: technicalCount,
    document_count: firstAvailableCount(project.document_count, tenderCount + businessCount + technicalCount),
  }
}

function mergeProjectMeta(listProject, detailProject) {
  if (!listProject && !detailProject) return null

  return buildProjectMeta(
    {
      ...(listProject || {}),
      ...(detailProject || {}),
    },
    detailProject?.relations || listProject?.relations || [],
  )
}

function getProjectLogInfo(project, selectedProjectId) {
  const identifierId = getProjectIdentifier(project) || selectedProjectId || ''
  const projectName = getProjectName(project)

  return {
    id: identifierId,
    name: projectName || identifierId || '未选择项目',
  }
}

function getProjectDocumentCountForAnalysis(analysisType, project) {
  if (!project) return 0

  const businessCount = normalizeCount(project.business_bid_count) ?? 0
  const technicalCount = normalizeCount(project.technical_bid_count) ?? 0
  const totalCount = normalizeCount(project.document_count) ?? 0

  if (
    analysisType.key === 'businessBidDuplicateCheck' ||
    analysisType.key === 'personnelReuseCheck' ||
    analysisType.key === 'businessBidFormatReview'
  ) {
    return businessCount
  }

  if (analysisType.key === 'technicalBidDuplicateCheck') {
    return technicalCount
  }

  if (analysisType.key === 'typoCheck') {
    return firstAvailableCount(totalCount, project.tender_count + businessCount + technicalCount)
  }

  return 0
}

function getServiceResultContainer(apiResult) {
  if (isPlainObject(apiResult?.results)) return apiResult.results
  return isPlainObject(apiResult) ? apiResult : {}
}

function unwrapServiceResult(serviceKey, result) {
  if (!isPlainObject(result)) return null

  const candidates = serviceKey === 'business_bid_format_review'
    ? [result.review, result.result, result.data, result]
    : [result.result, result.data, result]

  for (const candidate of candidates) {
    if (isPlainObject(candidate)) {
      return candidate
    }
  }

  return null
}

function getFormatReviewBidders(result) {
  return arrayify(result?.bidders).concat(objectValues(result?.bidders))
}

function countFormatReviewIssues(result) {
  let count = 0

  getFormatReviewBidders(result).forEach((bidder) => {
    Object.values(bidder?.checks || {}).forEach((check) => {
      const issues = check?.issues || {}
      const issueCount = arrayify(issues.failed).length +
        arrayify(issues.missing).length +
        arrayify(issues.unclear).length

      count += issueCount
    })
  })

  const statusCounts = result?.summary?.review_status_counts || {}
  const statusIssueCount =
    (Number(statusCounts.fail) || 0) +
    (Number(statusCounts.missing) || 0) +
    (Number(statusCounts.unclear) || 0)

  return firstAvailableCount(
    count,
    statusIssueCount,
    result?.overview?.failed_count,
    result?.overview?.issue_count,
  )
}

function countFormatReviewDocuments(result) {
  return firstAvailableCount(
    result?.summary?.document_count,
    result?.summary?.bidder_count,
    result?.document_count,
    result?.bidder_count,
    getFormatReviewBidders(result).length,
    collectionSize(result?.documents),
  )
}

function countGroupDocuments(groups) {
  return objectValues(groups).reduce((total, group) => {
    return total + firstAvailableCount(
      group?.document_count,
      group?.summary?.document_count,
      collectionSize(group?.documents),
    )
  }, 0)
}

function isDuplicateIssueVisible(item) {
  const riskLevel = String(item.risk_level || '').toLowerCase()
  return Boolean(item) && riskLevel !== '' && riskLevel !== 'none'
}

function getDuplicateIssueItems(result) {
  const directIssues = arrayify(result?.issues)
  if (directIssues.length > 0) return directIssues

  return objectValues(result?.groups).flatMap((group) => arrayify(group?.issues))
}

function countDuplicateIssues(result) {
  return firstAvailableCount(
    getDuplicateIssueItems(result).filter(isDuplicateIssueVisible).length,
    result?.summary?.suspicious_pair_count,
    result?.summary?.high_risk_pair_count,
    result?.summary?.medium_risk_pair_count,
    result?.suspicious_pair_count,
  )
}

function countDuplicateDocuments(result) {
  return firstAvailableCount(
    result?.summary?.document_count,
    result?.document_count,
    countGroupDocuments(result?.groups),
    collectionSize(result?.documents),
  )
}

function countPersonnelIssues(result) {
  let count = 0
  Object.values(result?.groups || {}).forEach((groupValue) => {
    const check = groupValue?.personnel_reuse_check || {}
    count += arrayify(check.items).length || arrayify(check.issues).length
  })
  return firstAvailableCount(
    count,
    result?.summary?.reused_name_count,
    result?.summary?.suspicious_document_count,
    result?.summary?.suspicious ? 1 : 0,
  )
}

function countPersonnelDocuments(result) {
  const groupedDocumentCount = objectValues(result?.groups).reduce((total, groupValue) => {
    const check = groupValue?.personnel_reuse_check || {}
    return total + firstAvailableCount(
      check?.document_count,
      check?.summary?.document_count,
      groupValue?.summary?.document_count,
      collectionSize(check?.documents),
      collectionSize(groupValue?.documents),
    )
  }, 0)

  return firstAvailableCount(
    result?.summary?.document_count,
    result?.summary?.total_document_count,
    result?.summary?.total_documents,
    result?.document_count,
    groupedDocumentCount,
    result?.summary?.total,
  )
}

function countTypoIssues(result) {
  let count = 0
  objectValues(result?.groups).forEach((groupValue) => {
    arrayify(groupValue?.typo_check?.documents).forEach((doc) => {
      count += arrayify(doc.items).length
    })
  })
  return firstAvailableCount(
    count,
    result?.summary?.suspicious_typo_document_count,
    result?.summary?.suspicious_document_count,
    result?.summary?.suspicious ? 1 : 0,
  )
}

function countTypoDocuments(result) {
  const groupedDocumentCount = objectValues(result?.groups).reduce((total, groupValue) => {
    return total + firstAvailableCount(
      groupValue?.summary?.document_count,
      collectionSize(groupValue?.typo_check?.documents),
      collectionSize(groupValue?.documents),
    )
  }, 0)

  return firstAvailableCount(
    result?.summary?.document_count,
    result?.document_count,
    groupedDocumentCount,
    collectionSize(result?.documents),
  )
}

const SERVICE_SUMMARIZERS = {
  business_bid_format_review: {
    countDocuments: countFormatReviewDocuments,
    countIssues: countFormatReviewIssues,
  },
  business_bid_duplicate_check: {
    countDocuments: countDuplicateDocuments,
    countIssues: countDuplicateIssues,
  },
  technical_bid_duplicate_check: {
    countDocuments: countDuplicateDocuments,
    countIssues: countDuplicateIssues,
  },
  personnel_reuse_check: {
    countDocuments: countPersonnelDocuments,
    countIssues: countPersonnelIssues,
  },
  typo_check: {
    countDocuments: countTypoDocuments,
    countIssues: countTypoIssues,
  },
}

function summarizeServiceResult(serviceKey, rawResult) {
  const payload = unwrapServiceResult(serviceKey, rawResult)
  if (!payload) return null

  return {
    payload,
    documentCount: SERVICE_SUMMARIZERS[serviceKey]?.countDocuments(payload) ?? 0,
    suspiciousCount: SERVICE_SUMMARIZERS[serviceKey]?.countIssues(payload) ?? 0,
  }
}

function normalizeAnalysisResult(analysisType, apiResult, projectMeta) {
  const results = getServiceResultContainer(apiResult)
  const summaries = analysisType.services
    .map((serviceKey) => summarizeServiceResult(serviceKey, results[serviceKey]))
    .filter(Boolean)

  if (summaries.length === 0) {
    return { summary: { document_count: getProjectDocumentCountForAnalysis(analysisType, projectMeta), suspicious: 0 } }
  }

  const documentCount = firstAvailableCount(
    summaries.reduce((total, item) => total + item.documentCount, 0),
    getProjectDocumentCountForAnalysis(analysisType, projectMeta),
  )
  const suspiciousCount = summaries.reduce((total, item) => total + item.suspiciousCount, 0)
  const basePayload = summaries.length === 1 ? summaries[0].payload : apiResult

  return {
    ...basePayload,
    summary: {
      ...(basePayload.summary || {}),
      document_count: documentCount,
      suspicious: suspiciousCount,
    },
  }
}

function getRunItemForService(apiResult, serviceKey) {
  return arrayify(apiResult?.items).find((item) =>
    item?.service === serviceKey || item?.result_key === serviceKey
  )
}

function getAnalysisTypeRunError(analysisType, apiResult) {
  for (const serviceKey of analysisType.services) {
    const item = getRunItemForService(apiResult, serviceKey)
    if (item && item.status && item.status !== 'success') {
      return item.error || `${analysisType.label} 执行失败`
    }
  }

  return ''
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

function canUseAnalysisType(analysisType, parsingStatus) {
  return Number(parsingStatus || 0) >= (analysisType.requiredParsingStatus ?? Infinity)
}

function getDisabledHint(analysisType, parsingStatus) {
  if (canUseAnalysisType(analysisType, parsingStatus)) return ''

  return analysisType.requiredParsingStatus >= PARSING_STATUS_TECHNICAL_READY
    ? '技术标解析完成后可用'
    : '商务标解析完成后可用'
}

function buildAnalysisViewState(allResults, projectMeta) {
  const cardResults = {}
  const statusMap = {}

  ANALYSIS_TYPES.forEach((analysisType) => {
    const hasServiceResult = analysisType.services.some((serviceKey) => allResults[serviceKey])

    if (!hasServiceResult) return

    cardResults[analysisType.key] = normalizeAnalysisResult(analysisType, { results: allResults }, projectMeta)
    statusMap[analysisType.key] = 'success'
  })

  return { cardResults, statusMap }
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
  const [selectedProjectMeta, setSelectedProjectMeta] = useState(null)
  const selectedProjectIdRef = useRef(selectedProjectId)

  const currentProjectMeta = useMemo(() => {
    const listProject = projects.find((item) => String(getProjectIdentifier(item)) === String(selectedProjectId || '')) || null
    return mergeProjectMeta(listProject, selectedProjectMeta)
  }, [projects, selectedProjectId, selectedProjectMeta])

  const enabledAnalysisTypes = useMemo(() => (
    ANALYSIS_TYPES.filter((analysisType) => canUseAnalysisType(analysisType, selectedProjectParsingStatus))
  ), [selectedProjectParsingStatus])

  const isRunning = useMemo(() => Object.values(analysisStatus).some((status) => status === 'running'), [analysisStatus])

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId
  }, [selectedProjectId])

  const loadProjects = useCallback(async () => {
    try {
      const listing = await listProjects({ pageSize: 100 })
      setProjects(listing.items ?? [])
    } catch {
      setNotice({ type: 'error', message: '项目列表加载失败' })
    }
  }, [])

  const refreshProjectResults = useCallback(async () => {
    const projectId = selectedProjectId
    if (!projectId) return

    const [detailResult, resultsResult] = await Promise.allSettled([
      getProjectDetail(projectId),
      getProjectResults(projectId),
    ])

    if (String(selectedProjectIdRef.current || '') !== String(projectId || '')) return

    const detailValue = detailResult.status === 'fulfilled' ? detailResult.value : null
    const detailProject = detailValue
      ? buildProjectMeta(detailValue.project || detailValue, detailValue.relations)
      : null
    const listProject = projects.find((item) => String(getProjectIdentifier(item)) === String(projectId || '')) || null
    const projectMeta = mergeProjectMeta(listProject, detailProject)

    if (projectMeta) {
      setSelectedProjectMeta(projectMeta)
      setSelectedProjectParsingStatus(projectMeta?.parsing_status ?? 0)
    }

    if (resultsResult.status === 'fulfilled') {
      const allResults = normalizeProjectResultsPayload(resultsResult.value)
      const viewState = buildAnalysisViewState(allResults, projectMeta)
      setResults((prev) => ({ ...prev, ...viewState.cardResults }))
      setAnalysisStatus((prev) => ({ ...prev, ...viewState.statusMap }))
    }
  }, [projects, selectedProjectId])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    let cancelled = false

    if (!selectedProjectId) {
      setResults({})
      setAnalysisStatus({})
      setSelectedProjectParsingStatus(0)
      setSelectedProjectMeta(null)
      setCheckedServices(new Set())
      return undefined
    }

    setResults({})
    setAnalysisStatus({})
    setSelectedProjectParsingStatus(0)
    setSelectedProjectMeta(null)
    setCheckedServices(new Set())

    Promise.allSettled([
      getProjectDetail(selectedProjectId),
      getProjectResults(selectedProjectId),
    ]).then(([detailResult, resultsResult]) => {
      if (cancelled) return

      const detailValue = detailResult.status === 'fulfilled' ? detailResult.value : null
      const detailProject = detailValue
        ? buildProjectMeta(detailValue.project || detailValue, detailValue.relations)
        : null
      const listProject = projects.find((item) => String(getProjectIdentifier(item)) === String(selectedProjectId || '')) || null
      const projectMeta = mergeProjectMeta(listProject, detailProject)

      setSelectedProjectMeta(projectMeta)
      setSelectedProjectParsingStatus(projectMeta?.parsing_status ?? 0)

      if (resultsResult.status === 'fulfilled') {
        const allResults = normalizeProjectResultsPayload(resultsResult.value)
        const viewState = buildAnalysisViewState(allResults, projectMeta)
        setResults(viewState.cardResults)
        setAnalysisStatus(viewState.statusMap)
      }
    })

    return () => {
      cancelled = true
    }
  }, [projects, selectedProjectId])

  useEffect(() => {
    setCheckedServices((prev) => {
      const next = new Set([...prev].filter((key) => {
        const analysisType = ANALYSIS_TYPES.find((item) => item.key === key)
        return analysisType && canUseAnalysisType(analysisType, selectedProjectParsingStatus)
      }))

      return next.size === prev.size ? prev : next
    })
  }, [selectedProjectParsingStatus])

  function handleProjectChange(projectId) {
    setSelectedProjectId(projectId)
    setSearchParams(projectId ? { projectId } : {})
    setResults({})
    setAnalysisStatus({})
    setCheckedServices(new Set())
    setSelectedProjectParsingStatus(0)
    setSelectedProjectMeta(null)
  }

  function isServiceDisabled(analysisType) {
    return !canUseAnalysisType(analysisType, selectedProjectParsingStatus)
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
      const enabledKeys = enabledAnalysisTypes.map((t) => t.key)
      if (enabledKeys.length === 0) return new Set()
      if (enabledKeys.every((k) => prev.has(k))) {
        return new Set()
      }
      return new Set(enabledKeys)
    })
  }

  async function handleBatchExecute() {
    if (!selectedProjectId || checkedServices.size === 0) return

    const keys = [...checkedServices]
    const typesToRun = ANALYSIS_TYPES.filter((t) => keys.includes(t.key) && !isServiceDisabled(t))
    if (typesToRun.length === 0) {
      setCheckedServices(new Set())
      return
    }

    // 收集所有需要执行的服务（去重）
    const allServices = [...new Set(typesToRun.flatMap((t) => t.services))]

    // 标记所有选中类型为执行中
    const projectLogInfo = getProjectLogInfo(currentProjectMeta, selectedProjectId)
    for (const analysisType of typesToRun) {
      setAnalysisStatus((prev) => ({ ...prev, [analysisType.key]: 'running' }))
      addLog(analysisType.label, 'running', projectLogInfo)
    }

    try {
      const result = await runAnalysis({
        projectIdentifier: selectedProjectId,
        services: allServices,
      })

      // 一次调用返回所有结果，根据各类型需要的服务提取对应结果
      const failedTypes = []
      for (const analysisType of typesToRun) {
        const runError = getAnalysisTypeRunError(analysisType, result)
        if (runError) {
          failedTypes.push(`${analysisType.label}: ${runError}`)
          setAnalysisStatus((prev) => ({ ...prev, [analysisType.key]: 'error' }))
          updateLog(analysisType.label, 'error', projectLogInfo.id)
          continue
        }

        const normalizedResult = normalizeAnalysisResult(analysisType, result, currentProjectMeta)
        setAnalysisStatus((prev) => ({ ...prev, [analysisType.key]: 'success' }))
        setResults((prev) => ({ ...prev, [analysisType.key]: normalizedResult }))
        updateLog(analysisType.label, 'success', projectLogInfo.id)
      }

      if (failedTypes.length > 0) {
        setNotice({ type: 'error', message: failedTypes.join('；') })
      }
      await refreshProjectResults()
    } catch (error) {
      for (const analysisType of typesToRun) {
        setAnalysisStatus((prev) => ({ ...prev, [analysisType.key]: 'error' }))
        updateLog(analysisType.label, 'error', projectLogInfo.id)
      }
      setNotice({ type: 'error', message: `分析执行失败: ${error.message}` })
    }
  }

  function addLog(type, status, project) {
    setExecutionLog((prev) => [
      {
        id: Date.now() + Math.random(),
        time: new Date(),
        projectId: project?.id || '',
        projectName: project?.name || '未选择项目',
        type,
        status,
      },
      ...prev.slice(0, 9),
    ])
  }

  function updateLog(type, status, projectId) {
    setExecutionLog((prev) =>
      prev.map((entry) =>
        entry.type === type && entry.projectId === projectId && entry.status === 'running'
          ? { ...entry, status }
          : entry,
      ),
    )
  }

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
              const enabledKeys = enabledAnalysisTypes.map((t) => t.key)
              return enabledKeys.length > 0 && enabledKeys.every((k) => checkedServices.has(k))
            })()}
            disabled={!selectedProjectId || enabledAnalysisTypes.length === 0}
            onChange={toggleAllServices}
          />
          <span>全选</span>
        </label>
        <span className="toolbar-count">已选 {checkedServices.size} 项</span>
        <button
          type="button"
          className="primary-button"
          onClick={handleBatchExecute}
          disabled={!selectedProjectId || enabledAnalysisTypes.length === 0 || checkedServices.size === 0 || isRunning}
        >
          {isRunning ? '执行中...' : '执行选中服务'}
        </button>
      </section>

      {(() => {
        const businessGroup = ANALYSIS_TYPES.filter((t) => (t.requiredParsingStatus ?? 0) === 2)
        const technicalGroup = ANALYSIS_TYPES.filter((t) => (t.requiredParsingStatus ?? 0) === 3)

        function renderCard(analysisType) {
          const status = analysisStatus[analysisType.key] ?? 'idle'
          const result = results[analysisType.key]
          const suspiciousCount = result?.summary?.suspicious ?? 0
          const disabled = isServiceDisabled(analysisType)
          const disabledHint = getDisabledHint(analysisType, selectedProjectParsingStatus)

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
                <span className="analysis-card-hint">{disabledHint}</span>
              ) : null}

              {status === 'success' && result ? (
                <div className="analysis-card-result">
                  <span>
                    共检查 {result.summary?.document_count ?? '--'} 份文档
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
                <th>项目</th>
                <th>分析类型</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {executionLog.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDateTime(entry.time)}</td>
                  <td className="log-project-cell">
                    <span>{entry.projectName || entry.projectId || '--'}</span>
                    {entry.projectId && entry.projectName !== entry.projectId ? (
                      <small>{entry.projectId}</small>
                    ) : null}
                  </td>
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
