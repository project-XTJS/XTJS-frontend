import { useCallback, useEffect, useState, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  exportReport,
  getDocumentPreview,
  getProjectVisualizationData,
  listProjects,
} from '../lib/xtjsApi'
import { DOCUMENT_LABELS } from '../utils/formatters'
import EmptyBlock from '../components/EmptyBlock'
import ProjectDropdown from '../components/ProjectDropdown'

var RESULT_TYPE_LABELS = {
  duplicate_check: '全文查重',
  business_bid_duplicate_check: '商务标查重',
  technical_bid_duplicate_check: '技术标查重',
  business_bid_format_review: '形式审查',
  personnel_reuse_check: '人员复用',
  typo_check: '错字检查',
  bid_document_review: '综合审查',
}

var RESULT_TYPE_CATEGORIES = [
  {
    label: '查重类',
    types: ['duplicate_check', 'business_bid_duplicate_check', 'technical_bid_duplicate_check'],
  },
  {
    label: '审查类',
    types: ['business_bid_format_review', 'bid_document_review'],
  },
  {
    label: '其他',
    types: ['personnel_reuse_check', 'typo_check'],
  },
]

var RESULT_TYPE_COLORS = {
  duplicate_check: '#dc2626',
  business_bid_duplicate_check: '#ea580c',
  technical_bid_duplicate_check: '#f59e0b',
  business_bid_format_review: '#2563eb',
  personnel_reuse_check: '#9333ea',
  typo_check: '#0891b2',
  bid_document_review: '#7c3aed',
}

function collectAllAlerts(results) {
  if (!results) return []

  var allAlerts = []

  var duplicateTypes = ['duplicate_check', 'business_bid_duplicate_check', 'technical_bid_duplicate_check']
  for (var di = 0; di < duplicateTypes.length; di++) {
    var key = duplicateTypes[di]
    var result = results[key]
    if (!result || !result.groups) continue

    var groupEntries = Object.entries(result.groups)
    for (var gi = 0; gi < groupEntries.length; gi++) {
      var groupKey = groupEntries[gi][0]
      var groupValue = groupEntries[gi][1]
      var items = groupValue.items || []
      for (var ii = 0; ii < items.length; ii++) {
        var item = items[ii]
        if (!item.suspicious) continue
        allAlerts.push({
          id: key + '-' + item.left_document_identifier + '-' + item.right_document_identifier,
          resultType: key,
          resultTypeLabel: RESULT_TYPE_LABELS[key] || key,
          groupLabel: DOCUMENT_LABELS[groupKey] || groupKey,
          riskLevel: item.risk_level || 'none',
          title: item.left_file_name + ' / ' + item.right_file_name,
          description: '匹配得分 ' + (item.match_score || item.exact_match_score || '--'),
          metrics: {
            exactBlockOverlapRatio: (item.metrics && item.metrics.exact_block_overlap_ratio) || 0,
            exactBlockCount: (item.metrics && item.metrics.exact_block_count) || 0,
            similarBlockCount: (item.metrics && item.metrics.similar_block_count) || 0,
          },
          evidence: {
            duplicateBlocks: item.duplicate_blocks || [],
            similarBlocks: item.similar_blocks || [],
            duplicateTables: item.duplicate_tables || [],
          },
          leftFileName: item.left_file_name,
          rightFileName: item.right_file_name,
          leftDocumentId: item.left_document_identifier,
          rightDocumentId: item.right_document_identifier,
        })
      }
    }
  }

  // Typo check alerts
  var typoResult = results.typo_check
  if (typoResult && typoResult.groups) {
    var typoGroupEntries = Object.entries(typoResult.groups)
    for (var tgi = 0; tgi < typoGroupEntries.length; tgi++) {
      var typoGroupKey = typoGroupEntries[tgi][0]
      var typoGroupValue = typoGroupEntries[tgi][1]
      var docs = (typoGroupValue.typo_check && typoGroupValue.typo_check.documents) || []
      for (var di2 = 0; di2 < docs.length; di2++) {
        var doc = docs[di2]
        var docItems = doc.items || []
        for (var dii = 0; dii < docItems.length; dii++) {
          var typoItem = docItems[dii]
          allAlerts.push({
            id: 'typo-' + typoItem.document_identifier_id + '-' + typoItem.page + '-' + typoItem.issue_key,
            resultType: 'typo_check',
            resultTypeLabel: RESULT_TYPE_LABELS.typo_check,
            groupLabel: DOCUMENT_LABELS[typoGroupKey] || typoGroupKey,
            riskLevel: 'medium',
            title: typoItem.file_name || doc.file_name,
            description: '错字: ' + (typoItem.matched_text || '') + ' -> ' + (typoItem.suggestion || '') + ', 第' + typoItem.page + '页',
            metrics: { page: typoItem.page },
            evidence: {
              matchedText: typoItem.matched_text,
              suggestion: typoItem.suggestion,
              page: typoItem.page,
              bbox: typoItem.bbox,
            },
            documentId: typoItem.document_identifier_id || doc.identifier_id,
          })
        }
      }
    }
  }

  // Personnel reuse alerts
  var personnelResult = results.personnel_reuse_check
  if (personnelResult && personnelResult.groups) {
    var pGroupEntries = Object.entries(personnelResult.groups)
    for (var pgi = 0; pgi < pGroupEntries.length; pgi++) {
      var pGroupValue = pGroupEntries[pgi][1]
      var pItems = (pGroupValue.personnel_reuse_check && pGroupValue.personnel_reuse_check.items) || []
      for (var pii = 0; pii < pItems.length; pii++) {
        var pItem = pItems[pii]
        allAlerts.push({
          id: 'personnel-' + pItem.name,
          resultType: 'personnel_reuse_check',
          resultTypeLabel: RESULT_TYPE_LABELS.personnel_reuse_check,
          groupLabel: DOCUMENT_LABELS[pGroupValue.document_type] || '',
          riskLevel: pItem.document_count > 2 ? 'high' : 'medium',
          title: pItem.name,
          description: '在 ' + pItem.document_count + ' 份文档中重复出现',
          metrics: { documentCount: pItem.document_count },
          evidence: { documents: pItem.documents || [] },
        })
      }
    }
  }

  // Bid document review alerts
  var reviewResult = results.bid_document_review
  if (reviewResult && reviewResult.groups) {
    var rGroupEntries = Object.entries(reviewResult.groups)
    for (var rgi = 0; rgi < rGroupEntries.length; rgi++) {
      var rGroupKey = rGroupEntries[rgi][0]
      var rGroupValue = rGroupEntries[rgi][1]

      var rTypos = (rGroupValue.typo_check && rGroupValue.typo_check.documents) || []
      for (var rti = 0; rti < rTypos.length; rti++) {
        var rDoc = rTypos[rti]
        var rDocItems = rDoc.items || []
        for (var rdii = 0; rdii < rDocItems.length; rdii++) {
          var rTypoItem = rDocItems[rdii]
          allAlerts.push({
            id: 'review-typo-' + rTypoItem.document_identifier_id + '-' + rTypoItem.page + '-' + rTypoItem.issue_key,
            resultType: 'bid_document_review',
            resultTypeLabel: RESULT_TYPE_LABELS.bid_document_review,
            groupLabel: DOCUMENT_LABELS[rGroupKey] || rGroupKey,
            riskLevel: 'medium',
            title: rTypoItem.file_name || rDoc.file_name,
            description: '错字: ' + (rTypoItem.matched_text || '') + ' -> ' + (rTypoItem.suggestion || ''),
            metrics: { page: rTypoItem.page },
            evidence: { matchedText: rTypoItem.matched_text, suggestion: rTypoItem.suggestion, page: rTypoItem.page },
            documentId: rTypoItem.document_identifier_id || rDoc.identifier_id,
          })
        }
      }

      var rPersonnelItems = (rGroupValue.personnel_reuse_check && rGroupValue.personnel_reuse_check.items) || []
      for (var rpii = 0; rpii < rPersonnelItems.length; rpii++) {
        var rpItem = rPersonnelItems[rpii]
        allAlerts.push({
          id: 'review-personnel-' + rpItem.name,
          resultType: 'bid_document_review',
          resultTypeLabel: RESULT_TYPE_LABELS.bid_document_review,
          groupLabel: DOCUMENT_LABELS[rGroupKey] || rGroupKey,
          riskLevel: rpItem.document_count > 2 ? 'high' : 'medium',
          title: rpItem.name,
          description: '在 ' + rpItem.document_count + ' 份文档中重复出现',
          metrics: { documentCount: rpItem.document_count },
          evidence: { documents: rpItem.documents || [] },
        })
      }
    }
  }

  var order = { high: 3, medium: 2, low: 1, none: 0 }
  return allAlerts.sort(function (a, b) {
    return (order[b.riskLevel] || 0) - (order[a.riskLevel] || 0)
  })
}

var RISK_CLASSES = {
  high: 'risk-high',
  medium: 'risk-medium',
  low: 'risk-low',
  none: 'risk-none',
}

var RISK_LABELS = {
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  none: 'NONE',
}

// Extract document list from an alert for PDF preview rendering
function getAlertDocIds(alert) {
  var docs = []

  // Duplicate check: left + right documents
  if (alert.leftDocumentId && alert.rightDocumentId) {
    var dupBlocks = alert.evidence && alert.evidence.duplicateBlocks
    var firstBlock = dupBlocks && dupBlocks[0]
    docs.push({
      docId: alert.leftDocumentId,
      label: alert.leftFileName || '文档 A',
      startPage: (firstBlock && (firstBlock.left_page || firstBlock.page)) || 1,
    })
    docs.push({
      docId: alert.rightDocumentId,
      label: alert.rightFileName || '文档 B',
      startPage: (firstBlock && firstBlock.right_page) || 1,
    })
    return docs
  }

  // Single document (typo, review-typo)
  if (alert.documentId) {
    docs.push({
      docId: alert.documentId,
      label: alert.title || '文档',
      startPage: (alert.evidence && alert.evidence.page) || 1,
    })
    return docs
  }

  // Personnel reuse: multiple documents
  var personnelDocs = (alert.evidence && alert.evidence.documents) || []
  for (var i = 0; i < personnelDocs.length; i++) {
    var d = personnelDocs[i]
    if (d.identifier_id) {
      docs.push({
        docId: d.identifier_id,
        label: d.file_name || ('文档 ' + (i + 1)),
        startPage: 1,
      })
    }
  }

  return docs
}

export default function ReviewPage() {
  var [searchParams, setSearchParams] = useSearchParams()
  var [projects, setProjects] = useState([])
  var [selectedProjectId, setSelectedProjectId] = useState(searchParams.get('projectId') || '')
  var [results, setResults] = useState(null)
  var [allAlerts, setAllAlerts] = useState([])
  var [currentServiceType, setCurrentServiceType] = useState(null)
  var [currentAlertIndex, setCurrentAlertIndex] = useState(0)
  var [reviewStatus, setReviewStatus] = useState({})
  var [reviewNotes, setReviewNotes] = useState({})
  var [showExport, setShowExport] = useState(false)
  var [notice, setNotice] = useState(null)
  var [isLoading, setIsLoading] = useState(true)
  var [selectedAlerts, setSelectedAlerts] = useState(new Set())
  // PDF preview state
  var [previewData, setPreviewData] = useState({})
  var [previewPages, setPreviewPages] = useState({})
  var [previewLoading, setPreviewLoading] = useState(false)
  var [exportLoading, setExportLoading] = useState(false)
  var exportModalRef = useRef(null)

  var loadProjects = useCallback(function () {
    listProjects({ pageSize: 100 }).then(function (listing) {
      setProjects(listing.items || [])
    }).catch(function () {
      // ignore
    })
  }, [])

  var loadData = useCallback(function (projectId) {
    if (!projectId) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    getProjectVisualizationData(projectId).then(function (data) {
      var projectResults = data.results || {}
      setResults(projectResults)
      var alerts = collectAllAlerts(projectResults)
      setAllAlerts(alerts)
      setSelectedAlerts(new Set())

      // Auto-select first service type that has alerts
      var availableTypes = Object.keys(projectResults).filter(function (k) { return projectResults[k] })
      var firstTypeWithAlerts = null
      for (var ti = 0; ti < availableTypes.length; ti++) {
        if (alerts.some(function (a) { return a.resultType === availableTypes[ti] })) {
          firstTypeWithAlerts = availableTypes[ti]
          break
        }
      }
      setCurrentServiceType(firstTypeWithAlerts)
      setCurrentAlertIndex(0)
    }).catch(function () {
      setNotice({ type: 'error', message: '加载项目结果失败' })
    }).finally(function () {
      setIsLoading(false)
    })
  }, [])

  useEffect(function () {
    loadProjects()
  }, [loadProjects])

  useEffect(function () {
    loadData(selectedProjectId)
  }, [selectedProjectId, loadData])

  function handleProjectChange(projectId) {
    setSelectedProjectId(projectId)
    setSearchParams(projectId ? { projectId } : {})
    setReviewStatus({})
    setReviewNotes({})
    setSelectedAlerts(new Set())
    setPreviewData({})
    setPreviewPages({})
    setCurrentServiceType(null)
    setCurrentAlertIndex(0)
  }

  // Compute alerts for current service type
  var serviceAlerts = currentServiceType
    ? allAlerts.filter(function (a) { return a.resultType === currentServiceType })
    : []

  var currentAlert = serviceAlerts[currentAlertIndex] || null

  // Load previews for current alert
  useEffect(function () {
    if (!currentAlert) {
      setPreviewData({})
      return
    }

    var docIds = getAlertDocIds(currentAlert)
    if (docIds.length === 0) {
      setPreviewData({})
      return
    }

    setPreviewLoading(true)
    var cancelled = false

    var pages = {}
    docIds.forEach(function (d) {
      pages[d.docId] = previewPages[d.docId] || d.startPage
    })

    Promise.all(docIds.map(function (d) {
      return getDocumentPreview(d.docId, pages[d.docId])
        .then(function (preview) {
          return { docId: d.docId, preview: preview }
        })
        .catch(function () {
          return { docId: d.docId, preview: null }
        })
    })).then(function (results) {
      if (cancelled) return
      var newData = {}
      results.forEach(function (r) {
        newData[r.docId] = r.preview
      })
      setPreviewData(newData)
      setPreviewPages(pages)
      setPreviewLoading(false)
    })

    return function () { cancelled = true }
  }, [currentAlert])

  function selectServiceType(key) {
    setCurrentServiceType(key)
    setCurrentAlertIndex(0)
    setPreviewData({})
    setPreviewPages({})
  }

  function goToPrev() {
    if (currentAlertIndex > 0) {
      setCurrentAlertIndex(function (i) { return i - 1 })
      setPreviewData({})
      setPreviewPages({})
    }
  }

  function goToNext() {
    if (currentAlertIndex < serviceAlerts.length - 1) {
      setCurrentAlertIndex(function (i) { return i + 1 })
      setPreviewData({})
      setPreviewPages({})
    }
  }

  async function handleDocPageChange(docId, delta) {
    var currentPage = previewPages[docId] || 1
    var existing = previewData[docId]
    var pageCount = existing && existing.page_count
    var newPage = currentPage + delta
    if (newPage < 1) return
    if (pageCount && newPage > pageCount) return

    setPreviewPages(function (prev) {
      var next = {}
      for (var k in prev) { next[k] = prev[k] }
      next[docId] = newPage
      return next
    })

    try {
      var preview = await getDocumentPreview(docId, newPage)
      setPreviewData(function (prev) {
        var next = {}
        for (var k in prev) { next[k] = prev[k] }
        next[docId] = preview
        return next
      })
    } catch (e) {
      // ignore
    }
  }

  function handleReview(alertId, status) {
    setReviewStatus(function (prev) {
      var next = {}
      for (var key in prev) { next[key] = prev[key] }
      next[alertId] = { status: status, reviewedAt: new Date().toISOString() }
      return next
    })
  }

  function handleNote(alertId, note) {
    setReviewNotes(function (prev) {
      var next = {}
      for (var key in prev) { next[key] = prev[key] }
      next[alertId] = note
      return next
    })
  }

  function toggleAlertSelection(alertId) {
    setSelectedAlerts(function (prev) {
      var next = new Set(prev)
      if (next.has(alertId)) {
        next.delete(alertId)
      } else {
        next.add(alertId)
      }
      return next
    })
  }

  // Select/deselect all alerts in current service type
  function toggleSelectAllCurrent() {
    if (!currentServiceType) return
    setSelectedAlerts(function (prev) {
      var allSelected = serviceAlerts.every(function (a) { return prev.has(a.id) })
      if (allSelected) {
        var next = new Set(prev)
        serviceAlerts.forEach(function (a) { next.delete(a.id) })
        return next
      }
      var next = new Set(prev)
      serviceAlerts.forEach(function (a) { next.add(a.id) })
      return next
    })
  }

  function batchPassAll() {
    var newStatus = {}
    for (var key in reviewStatus) { newStatus[key] = reviewStatus[key] }
    serviceAlerts.forEach(function (alert) {
      if (!newStatus[alert.id]) {
        newStatus[alert.id] = { status: 'passed', reviewedAt: new Date().toISOString() }
      }
    })
    setReviewStatus(newStatus)
  }

  async function handleExport(options) {
    if (!selectedProjectId || selectedAlerts.size === 0) return

    setExportLoading(true)
    try {
      var blob = await exportReport(selectedProjectId, {
        alertIds: Array.from(selectedAlerts),
        options: options,
      })

      var url = window.URL.createObjectURL(blob)
      var a = document.createElement('a')
      a.href = url
      a.download = 'report-' + selectedProjectId + '.pdf'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)

      setNotice({ type: 'success', message: '报告导出成功' })
      setShowExport(false)
    } catch (e) {
      setNotice({ type: 'error', message: '导出失败: ' + (e.message || '未知错误') })
    } finally {
      setExportLoading(false)
    }
  }

  var resultTypeKeys = results ? Object.keys(results).filter(function (k) { return results[k] }) : []
  var resultTypeCounts = {}
  allAlerts.forEach(function (alert) {
    resultTypeCounts[alert.resultType] = (resultTypeCounts[alert.resultType] || 0) + 1
  })

  var reviewedCount = Object.keys(reviewStatus).length
  var totalCount = serviceAlerts.length
  var progressPercent = totalCount > 0 ? Math.round((reviewedCount / Math.max(totalCount, allAlerts.length)) * 100) : 0

  // Build category groups for sidebar
  var sidebarCategories = RESULT_TYPE_CATEGORIES.map(function (cat) {
    return {
      label: cat.label,
      types: cat.types.filter(function (t) { return resultTypeKeys.indexOf(t) !== -1 }),
    }
  }).filter(function (cat) { return cat.types.length > 0 })

  var selectedByType = {}
  selectedAlerts.forEach(function (id) {
    var alert = allAlerts.find(function (a) { return a.id === id })
    if (alert) {
      var rt = alert.resultTypeLabel
      selectedByType[rt] = (selectedByType[rt] || 0) + 1
    }
  })

  // Build PDF panels for current alert
  var pdfDocIds = currentAlert ? getAlertDocIds(currentAlert) : []

  return (
    <>
      {notice ? (
        <div className={'notice notice-' + notice.type}>
          <p>{notice.message}</p>
          <button
            type="button"
            className="text-button"
            onClick={function () { setNotice(null) }}
          >
            ✕
          </button>
        </div>
      ) : null}

      <section className="review-header">
        <div className="review-header-left">
          <h2>结果审核</h2>
          <ProjectDropdown
            projects={projects}
            selectedProjectId={selectedProjectId}
            onChange={handleProjectChange}
          />
        </div>

        <div className="review-header-right">
          {totalCount > 0 ? (
            <div className="review-progress">
              <div className="review-progress-bar">
                <div
                  className="review-progress-fill"
                  style={{ width: progressPercent + '%' }}
                />
              </div>
              <span>{progressPercent}% 已审核</span>
            </div>
          ) : null}

          {selectedAlerts.size > 0 ? (
            <span className="toolbar-selected-count">已选 {selectedAlerts.size} 项</span>
          ) : null}

          <button
            type="button"
            className="primary-button"
            onClick={function () { setShowExport(!showExport) }}
            disabled={!selectedProjectId || selectedAlerts.size === 0}
          >
            导出报告{selectedAlerts.size > 0 ? ' (' + selectedAlerts.size + ')' : ''}
          </button>
        </div>
      </section>

      {selectedProjectId ? (
        <main className="review-layout">
          <aside className="panel review-sidebar">
            <div className="panel-header">
              <h3>结果筛选</h3>
            </div>

            {currentServiceType ? (
              <div className="select-all-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={serviceAlerts.length > 0 && serviceAlerts.every(function (a) { return selectedAlerts.has(a.id) })}
                    onChange={toggleSelectAllCurrent}
                  />
                  <span>全选当前</span>
                </label>
              </div>
            ) : null}

            {sidebarCategories.map(function (cat) {
              return (
                <div key={cat.label} className="filter-category">
                  <div className="filter-category-title">{cat.label}</div>
                  <div className="filter-card-list">
                    {cat.types.map(function (key) {
                      var isActive = currentServiceType === key
                      var count = resultTypeCounts[key] || 0
                      var color = RESULT_TYPE_COLORS[key] || '#64748b'

                      return (
                        <button
                          key={key}
                          type="button"
                          className={'filter-card' + (isActive ? ' filter-card-active' : '')}
                          style={isActive ? { borderColor: color, background: color + '10' } : {}}
                          onClick={function () { selectServiceType(key) }}
                        >
                          <span
                            className="filter-card-dot"
                            style={{ background: isActive ? color : '#cbd5e1' }}
                          />
                          <span className="filter-card-label">{RESULT_TYPE_LABELS[key] || key}</span>
                          <span
                            className="filter-card-count"
                            style={isActive ? { background: color, color: '#fff' } : {}}
                          >
                            {count}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            <div className="review-actions">
              <button type="button" className="ghost-button" onClick={batchPassAll} disabled={!currentServiceType || serviceAlerts.length === 0}>
                一键通过全部
              </button>
            </div>
          </aside>

          <section className="review-main">
            {isLoading ? (
              <EmptyBlock title="加载中..." />
            ) : !currentServiceType ? (
              <EmptyBlock title={results ? '请从左侧选择一个服务类型' : '暂无分析结果'} />
            ) : serviceAlerts.length === 0 ? (
              <EmptyBlock title="该类型下未发现可疑项" />
            ) : currentAlert ? (
              <div className="detail-container">
                {/* ── Navigation bar ── */}
                <div className="detail-nav">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={currentAlertIndex === 0}
                    onClick={goToPrev}
                  >
                    ◀ 上一条
                  </button>
                  <span className="detail-nav-info">
                    第 {currentAlertIndex + 1}/{serviceAlerts.length} 条
                  </span>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={currentAlertIndex >= serviceAlerts.length - 1}
                    onClick={goToNext}
                  >
                    下一条 ▶
                  </button>
                </div>

                {/* ── Alert info ── */}
                <div className="panel detail-info">
                  <div className="detail-info-head">
                    <span className={'risk-tag ' + (RISK_CLASSES[currentAlert.riskLevel] || 'risk-none')}>
                      {RISK_LABELS[currentAlert.riskLevel] || currentAlert.riskLevel}
                    </span>
                    <span className="alert-tag">{currentAlert.resultTypeLabel}</span>
                    <span className="alert-tag">{currentAlert.groupLabel}</span>
                    {reviewStatus[currentAlert.id] ? (
                      <span className={'review-badge ' + (reviewStatus[currentAlert.id].status === 'passed' ? 'badge-passed' : 'badge-flagged')}>
                        {reviewStatus[currentAlert.id].status === 'passed' ? '✅ 已通过' : '⚠ 已标记'}
                      </span>
                    ) : null}
                  </div>

                  <strong className="alert-title">{currentAlert.title}</strong>
                  <p>{currentAlert.description}</p>

                  {currentAlert.metrics ? (
                    <div className="alert-metrics">
                      {Object.entries(currentAlert.metrics).map(function (entry) {
                        var key = entry[0]
                        var value = entry[1]
                        return (
                          <span key={key}>
                            {key}: {typeof value === 'number' ? value.toFixed ? value.toFixed(2) : value : value}
                          </span>
                        )
                      })}
                    </div>
                  ) : null}
                </div>

                {/* ── PDF preview row ── */}
                {pdfDocIds.length > 0 ? (
                  <div className="detail-pdf-row">
                    {previewLoading ? (
                      <div className="panel detail-pdf-panel detail-pdf-loading">
                        <EmptyBlock title="加载预览..." />
                      </div>
                    ) : (
                      pdfDocIds.map(function (docInfo) {
                        var preview = previewData[docInfo.docId]
                        var currentPage = previewPages[docInfo.docId] || docInfo.startPage
                        var pageCount = preview && preview.page_count

                        return (
                          <div className="panel detail-pdf-panel" key={docInfo.docId}>
                            <strong className="detail-pdf-name">{docInfo.label}</strong>
                            <div className="diff-page-preview">
                              {preview ? (
                                preview.image_data_url ? (
                                  <img
                                    src={preview.image_data_url}
                                    alt={docInfo.label}
                                    className="diff-image"
                                  />
                                ) : (
                                  <p>第 {preview.page} 页，共 {preview.page_count} 页</p>
                                )
                              ) : (
                                <p>无预览</p>
                              )}
                            </div>
                            <div className="pdf-page-nav">
                              <button
                                type="button"
                                className="pdf-page-btn"
                                disabled={currentPage <= 1}
                                onClick={function () { handleDocPageChange(docInfo.docId, -1) }}
                              >
                                ◀ 上一页
                              </button>
                              <span className="pdf-page-info">
                                {currentPage}{pageCount ? ' / ' + pageCount : ''}
                              </span>
                              <button
                                type="button"
                                className="pdf-page-btn"
                                disabled={pageCount && currentPage >= pageCount}
                                onClick={function () { handleDocPageChange(docInfo.docId, 1) }}
                              >
                                下一页 ▶
                              </button>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                ) : null}

                {/* ── Text evidence ── */}
                {currentAlert.evidence ? (
                  <div className="panel detail-text-block">
                    <strong>检测文字</strong>

                    {/* Duplicate blocks */}
                    {(currentAlert.evidence.duplicateBlocks || []).map(function (block, i) {
                      return (
                        <div key={'dup-' + i} className="diff-block">
                          <span className="diff-block-page">
                            第 {(block.left_page || block.page)} 页（左）/ 第 {(block.right_page || '--')} 页（右）
                          </span>
                          <p>{block.text || block.left_text}</p>
                        </div>
                      )
                    })}

                    {/* Similar blocks */}
                    {(currentAlert.evidence.similarBlocks || []).map(function (block, i) {
                      return (
                        <div key={'sim-' + i} className="diff-block diff-block-similar">
                          <span className="diff-block-page">
                            相似: L{block.left_page} / R{block.right_page}
                          </span>
                          <p>L: {block.left_text}</p>
                          <p>R: {block.right_text}</p>
                        </div>
                      )
                    })}

                    {/* Typo evidence */}
                    {currentAlert.evidence.matchedText ? (
                      <div className="diff-block">
                        <span className="diff-block-page">
                          第 {currentAlert.evidence.page} 页
                        </span>
                        <p>
                          检测到: <strong>{currentAlert.evidence.matchedText}</strong>
                          {currentAlert.evidence.suggestion ? ' → ' + currentAlert.evidence.suggestion : ''}
                        </p>
                      </div>
                    ) : null}

                    {/* Personnel documents list */}
                    {(currentAlert.evidence.documents || []).length > 0 && !currentAlert.evidence.matchedText && !currentAlert.evidence.duplicateBlocks ? (
                      (currentAlert.evidence.documents || []).map(function (doc, i) {
                        return (
                          <div key={'pdoc-' + i} className="diff-block">
                            <span className="diff-block-page">文档 {i + 1}</span>
                            <p>{doc.file_name}</p>
                          </div>
                        )
                      })
                    ) : null}
                  </div>
                ) : null}

                {/* ── Actions ── */}
                <div className="panel detail-actions">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedAlerts.has(currentAlert.id)}
                      onChange={function () { toggleAlertSelection(currentAlert.id) }}
                    />
                    <span>选择导出</span>
                  </label>

                  <div className="detail-review-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={function () { handleReview(currentAlert.id, 'passed') }}
                      disabled={reviewStatus[currentAlert.id] && reviewStatus[currentAlert.id].status === 'passed'}
                    >
                      审核通过
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={function () { handleReview(currentAlert.id, 'flagged') }}
                      disabled={reviewStatus[currentAlert.id] && reviewStatus[currentAlert.id].status === 'flagged'}
                    >
                      标记异常
                    </button>
                  </div>
                </div>

                {/* ── Notes ── */}
                <div className="panel detail-notes">
                  {reviewStatus[currentAlert.id] && reviewStatus[currentAlert.id].note ? (
                    <p className="review-note">备注: {reviewStatus[currentAlert.id].note}</p>
                  ) : null}
                  <input
                    className="review-note-input"
                    placeholder="添加备注..."
                    value={reviewNotes[currentAlert.id] || ''}
                    onChange={function (event) { handleNote(currentAlert.id, event.target.value) }}
                    onBlur={function () {
                      var note = reviewNotes[currentAlert.id] || ''
                      if (note.trim()) {
                        setReviewStatus(function (prev) {
                          var next = {}
                          for (var k in prev) { next[k] = prev[k] }
                          next[currentAlert.id] = Object.assign({}, prev[currentAlert.id], { note: note.trim() })
                          return next
                        })
                      }
                    }}
                  />
                </div>
              </div>
            ) : null}
          </section>
        </main>
      ) : (
        <section className="panel empty-panel">
          <EmptyBlock title="请先选择一个项目" />
        </section>
      )}

      {showExport ? (
        <div
          className="modal-overlay"
          onClick={function () { setShowExport(false) }}
          ref={exportModalRef}
        >
          <div
            className="modal-panel"
            onClick={function (event) { event.stopPropagation() }}
          >
            <div className="modal-header">
              <h3>导出审查报告</h3>
              <button
                type="button"
                className="text-button"
                onClick={function () { setShowExport(false) }}
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              <div className="export-summary">
                <div className="export-summary-item">
                  <span className="export-summary-label">选中项</span>
                  <span className="export-summary-value">{selectedAlerts.size} 项</span>
                </div>
                {Object.keys(selectedByType).length > 0 ? (
                  <div className="export-summary-types">
                    {Object.entries(selectedByType).map(function (entry) {
                      return (
                        <span key={entry[0]} className="export-type-tag">
                          {entry[0]} × {entry[1]}
                        </span>
                      )
                    })}
                  </div>
                ) : null}
              </div>

              <div className="export-section">
                <strong>导出选项</strong>
                <label className="export-option">
                  <input
                    type="checkbox"
                    id="exportIncludeScreenshots"
                    defaultChecked={false}
                  />
                  <span>包含 PDF 页面截图</span>
                </label>
                <label className="export-option">
                  <input
                    type="checkbox"
                    id="exportIncludeNotes"
                    defaultChecked={true}
                  />
                  <span>包含审核备注</span>
                </label>
                <label className="field" style={{ marginTop: 8 }}>
                  <span>报告标题</span>
                  <input
                    type="text"
                    id="exportReportTitle"
                    placeholder="可选：自定义报告标题..."
                  />
                </label>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="ghost-button"
                onClick={function () { setShowExport(false) }}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={exportLoading}
                onClick={function () {
                  handleExport({
                    includeScreenshots: document.getElementById('exportIncludeScreenshots').checked,
                    includeNotes: document.getElementById('exportIncludeNotes').checked,
                    reportTitle: document.getElementById('exportReportTitle').value,
                  })
                }}
              >
                {exportLoading ? '导出中...' : '导出 PDF'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
