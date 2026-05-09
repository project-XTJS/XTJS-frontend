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

// Group result types into categories for sidebar
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

// Color scheme for result type cards
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

  // Duplicate check alerts
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

  // Bid document review alerts (nested within bidDocumentReview)
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
        })
      }
    }
  }

  // Sort by risk level
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

// Extract page number from alert evidence for PDF navigation
function extractPageFromEvidence(alert) {
  if (!alert.evidence) return 1

  // For duplicate check: use first duplicate block's page
  var dupBlocks = alert.evidence.duplicateBlocks
  if (dupBlocks && dupBlocks.length > 0) {
    return dupBlocks[0].left_page || dupBlocks[0].page || 1
  }

  // For similar blocks
  var simBlocks = alert.evidence.similarBlocks
  if (simBlocks && simBlocks.length > 0) {
    return simBlocks[0].left_page || 1
  }

  // For typo check: direct page
  if (alert.evidence.page) {
    return alert.evidence.page
  }

  return 1
}

export default function ReviewPage() {
  var [searchParams, setSearchParams] = useSearchParams()
  var [projects, setProjects] = useState([])
  var [selectedProjectId, setSelectedProjectId] = useState(searchParams.get('projectId') || '')
  var [results, setResults] = useState(null)
  var [allAlerts, setAllAlerts] = useState([])
  var [filteredAlerts, setFilteredAlerts] = useState([])
  var [activeResultTypes, setActiveResultTypes] = useState(new Set())
  var [reviewStatus, setReviewStatus] = useState({})
  var [reviewNotes, setReviewNotes] = useState({})
  var [expandedAlert, setExpandedAlert] = useState(null)
  var [diffData, setDiffData] = useState(null)
  var [diffLoading, setDiffLoading] = useState(false)
  var [showExport, setShowExport] = useState(false)
  var [notice, setNotice] = useState(null)
  var [isLoading, setIsLoading] = useState(true)
  var [selectedAlerts, setSelectedAlerts] = useState(new Set())
  // PDF page navigation
  var [currentLeftPage, setCurrentLeftPage] = useState(1)
  var [currentRightPage, setCurrentRightPage] = useState(1)
  var [leftPageCount, setLeftPageCount] = useState(null)
  var [rightPageCount, setRightPageCount] = useState(null)
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
      setFilteredAlerts(alerts)
      setActiveResultTypes(new Set(Object.keys(projectResults).filter(function (k) { return projectResults[k] })))
      setSelectedAlerts(new Set())
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
    setExpandedAlert(null)
    setDiffData(null)
    setReviewStatus({})
    setReviewNotes({})
    setSelectedAlerts(new Set())
    setCurrentLeftPage(1)
    setCurrentRightPage(1)
  }

  function toggleResultType(key) {
    setActiveResultTypes(function (prev) {
      var next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  useEffect(function () {
    setFilteredAlerts(
      allAlerts.filter(function (alert) { return activeResultTypes.has(alert.resultType) }),
    )
  }, [allAlerts, activeResultTypes])

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

  // Toggle alert selection
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

  // Select all / deselect all visible alerts
  function toggleSelectAll() {
    setSelectedAlerts(function (prev) {
      if (prev.size >= filteredAlerts.length && filteredAlerts.length > 0) {
        return new Set()
      }
      return new Set(filteredAlerts.map(function (a) { return a.id }))
    })
  }

  // Load PDF preview for a specific page
  async function loadPagePreview(documentId, page, side) {
    try {
      var preview = await getDocumentPreview(documentId, page)
      if (side === 'left') {
        setLeftPageCount(preview.page_count)
      } else {
        setRightPageCount(preview.page_count)
      }
      return preview
    } catch (e) {
      return null
    }
  }

  async function handleExpandAlert(alert) {
    if (expandedAlert === alert.id) {
      setExpandedAlert(null)
      setDiffData(null)
      return
    }

    var startPage = extractPageFromEvidence(alert)

    setExpandedAlert(alert.id)
    setDiffLoading(true)
    setDiffData(null)
    setCurrentLeftPage(startPage)
    setCurrentRightPage(startPage)
    setLeftPageCount(null)
    setRightPageCount(null)

    try {
      var leftPreview = null
      var rightPreview = null

      if (alert.leftDocumentId) {
        leftPreview = await loadPagePreview(alert.leftDocumentId, startPage, 'left')
      }
      if (alert.rightDocumentId) {
        rightPreview = await loadPagePreview(alert.rightDocumentId, startPage, 'right')
      }

      setDiffData({
        left: leftPreview,
        right: rightPreview,
        evidence: alert.evidence,
        alert: alert,
      })
    } catch (e) {
      setDiffData({ error: true })
    } finally {
      setDiffLoading(false)
    }
  }

  // Change page for left or right document
  async function handlePageChange(side, delta) {
    var currentPage = side === 'left' ? currentLeftPage : currentRightPage
    var newPage = currentPage + delta
    if (newPage < 1) return

    var pageCount = side === 'left' ? leftPageCount : rightPageCount
    if (pageCount && newPage > pageCount) return

    // Update page state
    if (side === 'left') {
      setCurrentLeftPage(newPage)
    } else {
      setCurrentRightPage(newPage)
    }

    // Load preview for new page
    var alert = diffData && diffData.alert
    if (!alert) return

    var docId = side === 'left' ? alert.leftDocumentId : alert.rightDocumentId
    if (!docId) return

    var preview = await loadPagePreview(docId, newPage, side)
    setDiffData(function (prev) {
      if (!prev) return prev
      var next = {}
      for (var k in prev) { next[k] = prev[k] }
      if (side === 'left') {
        next.left = preview
      } else {
        next.right = preview
      }
      return next
    })
  }

  function batchPassAll() {
    var newStatus = {}
    for (var key in reviewStatus) { newStatus[key] = reviewStatus[key] }
    filteredAlerts.forEach(function (alert) {
      if (!newStatus[alert.id]) {
        newStatus[alert.id] = { status: 'passed', reviewedAt: new Date().toISOString() }
      }
    })
    setReviewStatus(newStatus)
  }

  // Handle export
  async function handleExport(options) {
    if (!selectedProjectId || selectedAlerts.size === 0) return

    setExportLoading(true)
    try {
      var blob = await exportReport(selectedProjectId, {
        alertIds: Array.from(selectedAlerts),
        options: options,
      })

      // Trigger download
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

  var reviewedCount = Object.values(reviewStatus).length
  var totalCount = filteredAlerts.length
  var progressPercent = totalCount > 0 ? Math.round((reviewedCount / totalCount) * 100) : 0

  // Build category groups for sidebar
  var sidebarCategories = RESULT_TYPE_CATEGORIES.map(function (cat) {
    return {
      label: cat.label,
      types: cat.types.filter(function (t) { return resultTypeKeys.indexOf(t) !== -1 }),
    }
  }).filter(function (cat) { return cat.types.length > 0 })

  // Count selected alerts by result type for export summary
  var selectedByType = {}
  selectedAlerts.forEach(function (id) {
    var alert = allAlerts.find(function (a) { return a.id === id })
    if (alert) {
      var rt = alert.resultTypeLabel
      selectedByType[rt] = (selectedByType[rt] || 0) + 1
    }
  })

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
              <span>{reviewedCount}/{totalCount} 项已审核 ({progressPercent}%)</span>
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

            <div className="select-all-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedAlerts.size >= filteredAlerts.length && filteredAlerts.length > 0}
                  onChange={toggleSelectAll}
                />
                <span>{selectedAlerts.size >= filteredAlerts.length && filteredAlerts.length > 0 ? '取消全选' : '全选当前'}</span>
              </label>
            </div>

            {sidebarCategories.map(function (cat) {
              return (
                <div key={cat.label} className="filter-category">
                  <div className="filter-category-title">{cat.label}</div>
                  <div className="filter-card-list">
                    {cat.types.map(function (key) {
                      var isActive = activeResultTypes.has(key)
                      var count = resultTypeCounts[key] || 0
                      var color = RESULT_TYPE_COLORS[key] || '#64748b'
                      var riskLevel = key.indexOf('duplicate') !== -1 ? '查重' : key.indexOf('review') !== -1 ? '审查' : '检查'

                      return (
                        <button
                          key={key}
                          type="button"
                          className={'filter-card' + (isActive ? ' filter-card-active' : '')}
                          style={isActive ? { borderColor: color, background: color + '10' } : {}}
                          onClick={function () { toggleResultType(key) }}
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
              <button type="button" className="ghost-button" onClick={batchPassAll}>
                一键通过全部
              </button>
            </div>
          </aside>

          <section className="review-main">
            {isLoading ? (
              <EmptyBlock title="加载中..." />
            ) : filteredAlerts.length > 0 ? (
              <div className="alert-list">
                {filteredAlerts.map(function (alert) {
                  var review = reviewStatus[alert.id]
                  var isReviewed = Boolean(review)
                  var isPassed = review && review.status === 'passed'
                  var isFlagged = review && review.status === 'flagged'
                  var isSelected = selectedAlerts.has(alert.id)

                  return (
                    <div
                      key={alert.id}
                      className={'alert-card review-alert-card' + (
                        isPassed ? ' alert-passed' : isFlagged ? ' alert-flagged' : ''
                      ) + (isSelected ? ' alert-selected' : '')}
                    >
                      <div className="alert-card-head">
                        <div className="alert-card-meta">
                          <label className="checkbox-label alert-checkbox">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={function () { toggleAlertSelection(alert.id) }}
                              onClick={function (event) { event.stopPropagation() }}
                            />
                          </label>
                          <span className={'risk-tag ' + (RISK_CLASSES[alert.riskLevel] || 'risk-none')}>
                            {RISK_LABELS[alert.riskLevel] || alert.riskLevel}
                          </span>
                          <span className="alert-tag">{alert.resultTypeLabel}</span>
                          <span className="alert-tag">{alert.groupLabel}</span>
                        </div>
                        {isReviewed ? (
                          <span className={'review-badge ' + (isPassed ? 'badge-passed' : 'badge-flagged')}>
                            {isPassed ? '✅ 已通过' : '⚠ 已标记'}
                          </span>
                        ) : null}
                      </div>

                      <strong className="alert-title">{alert.title}</strong>
                      <p>{alert.description}</p>

                      {alert.metrics ? (
                        <div className="alert-metrics">
                          {Object.entries(alert.metrics).map(function (entry) {
                            var key = entry[0]
                            var value = entry[1]
                            return (
                              <span key={key}>
                                {key}: {typeof value === 'number' ? value.toFixed(2) : value}
                              </span>
                            )
                          })}
                        </div>
                      ) : null}

                      <div className="alert-actions">
                        <button
                          type="button"
                          className="text-button"
                          onClick={function () { handleExpandAlert(alert) }}
                          disabled={!alert.evidence}
                        >
                          {expandedAlert === alert.id ? '收起对比' : '查看原文对比'}
                        </button>

                        <div className="alert-review-actions">
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={function () { handleReview(alert.id, 'passed') }}
                            disabled={isPassed}
                          >
                            审核通过
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={function () { handleReview(alert.id, 'flagged') }}
                            disabled={isFlagged}
                          >
                            标记异常
                          </button>
                        </div>
                      </div>

                      {review && review.note ? (
                        <p className="review-note">备注: {review.note}</p>
                      ) : null}

                      <input
                        className="review-note-input"
                        placeholder="添加备注..."
                        value={reviewNotes[alert.id] || ''}
                        onChange={function (event) { handleNote(alert.id, event.target.value) }}
                        onBlur={function () {
                          var note = reviewNotes[alert.id] || ''
                          if (note.trim()) {
                            setReviewStatus(function (prev) {
                              var next = {}
                              for (var k in prev) { next[k] = prev[k] }
                              next[alert.id] = Object.assign({}, prev[alert.id], { note: note.trim() })
                              return next
                            })
                          }
                        }}
                      />

                      {expandedAlert === alert.id ? (
                        <div className="diff-viewer">
                          {diffLoading ? (
                            <EmptyBlock title="加载对比数据..." />
                          ) : diffData && diffData.error ? (
                            <EmptyBlock title="无法加载原文对比" />
                          ) : diffData ? (
                            <div className="diff-content">
                              <div className="diff-panel">
                                <strong>{alert.leftFileName || '文档 A'}</strong>
                                {diffData.left ? (
                                  <div className="diff-page-preview">
                                    {diffData.left.image_data_url ? (
                                      <img
                                        src={diffData.left.image_data_url}
                                        alt={alert.leftFileName}
                                        className="diff-image"
                                      />
                                    ) : (
                                      <p>第 {diffData.left.page} 页，共 {diffData.left.page_count} 页</p>
                                    )}
                                    {/* Page navigation */}
                                    <div className="pdf-page-nav">
                                      <button
                                        type="button"
                                        className="pdf-page-btn"
                                        disabled={currentLeftPage <= 1}
                                        onClick={function () { handlePageChange('left', -1) }}
                                      >
                                        ◀ 上一页
                                      </button>
                                      <span className="pdf-page-info">
                                        {currentLeftPage}{leftPageCount ? ' / ' + leftPageCount : ''}
                                      </span>
                                      <button
                                        type="button"
                                        className="pdf-page-btn"
                                        disabled={leftPageCount && currentLeftPage >= leftPageCount}
                                        onClick={function () { handlePageChange('left', 1) }}
                                      >
                                        下一页 ▶
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <EmptyBlock title="无预览" />
                                )}
                              </div>

                              <div className="diff-panel">
                                <strong>{alert.rightFileName || '文档 B'}</strong>
                                {diffData.right ? (
                                  <div className="diff-page-preview">
                                    {diffData.right.image_data_url ? (
                                      <img
                                        src={diffData.right.image_data_url}
                                        alt={alert.rightFileName}
                                        className="diff-image"
                                      />
                                    ) : (
                                      <p>第 {diffData.right.page} 页，共 {diffData.right.page_count} 页</p>
                                    )}
                                    {/* Page navigation */}
                                    <div className="pdf-page-nav">
                                      <button
                                        type="button"
                                        className="pdf-page-btn"
                                        disabled={currentRightPage <= 1}
                                        onClick={function () { handlePageChange('right', -1) }}
                                      >
                                        ◀ 上一页
                                      </button>
                                      <span className="pdf-page-info">
                                        {currentRightPage}{rightPageCount ? ' / ' + rightPageCount : ''}
                                      </span>
                                      <button
                                        type="button"
                                        className="pdf-page-btn"
                                        disabled={rightPageCount && currentRightPage >= rightPageCount}
                                        onClick={function () { handlePageChange('right', 1) }}
                                      >
                                        下一页 ▶
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <EmptyBlock title="无预览" />
                                )}
                              </div>

                              {diffData.evidence ? (
                                <div className="diff-evidence">
                                  <strong>匹配片段</strong>
                                  {(diffData.evidence.duplicateBlocks || []).slice(0, 5).map(function (block, i) {
                                    return (
                                      <div key={i} className="diff-block">
                                        <span className="diff-block-page">第 {(block.left_page || block.page)} 页</span>
                                        <p>{block.text || block.left_text}</p>
                                      </div>
                                    )
                                  })}
                                  {(diffData.evidence.similarBlocks || []).slice(0, 3).map(function (block, i) {
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
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : (
              <EmptyBlock title={results ? '未发现可疑项' : '暂无分析结果'} />
            )}
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
              {/* Export summary */}
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
