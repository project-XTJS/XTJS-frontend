import { useCallback, useEffect, useMemo, useState } from 'react'
import FileUpload from '../components/FileUpload'
import {
  createTenderReview,
  deleteTenderReview,
  getDocumentPreview,
  getTenderReview,
  listTenderReviews,
  rerunTenderReview,
} from '../lib/xtjsApi'
import { formatDateTime } from '../utils/formatters'

const PAGE_SIZE = 50
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'fail', label: '异常' },
  { key: 'unclear', label: '待复核' },
  { key: 'pass', label: '通过' },
]

function arrayify(value) {
  return Array.isArray(value) ? value : []
}

function statusMeta(status) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'pass' || normalized === 'passed') return { label: '通过', tone: 'pass' }
  if (normalized === 'fail' || normalized === 'failed') return { label: '异常', tone: 'fail' }
  if (normalized === 'unclear') return { label: '待复核', tone: 'unclear' }
  if (normalized === 'running') return { label: '审查中', tone: 'running' }
  return { label: '未完成', tone: 'pending' }
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (!bytes) return '--'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatCompactValue(value) {
  if (value === null || value === undefined || value === '') return '--'
  if (typeof value === 'number') return Number.isInteger(value) ? `${value}` : `${Number(value.toFixed(4))}`
  if (typeof value === 'string') return value.length > 100 ? `${value.slice(0, 100)}...` : value
  if (Array.isArray(value)) {
    if (!value.length) return '--'
    if (value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
      return value.map(formatCompactValue).join('、')
    }
    return `${value.length} 项`
  }
  if (typeof value === 'object') {
    if (value.raw_amount || value.amount_yuan) return value.raw_amount || `${value.amount_yuan} 元`
    if (value.raw_value || value.percent !== undefined) return value.raw_value || `${value.percent}%`
    if (value.canonical) return formatCompactValue(value.canonical)
    const serialized = JSON.stringify(value)
    return serialized.length > 110 ? `${serialized.slice(0, 110)}...` : serialized
  }
  return String(value)
}

function valueLabel(key) {
  const labels = {
    budget: '项目预算',
    highest_limit: '最高限价',
    bid_security: '投标保证金',
    percent: '比例',
    ratio_percent: '占比',
    schedule: '前附表',
    technical: '技术需求',
    contract: '合同',
    total_score: '总分',
    category_scores: '大类分值',
    category_sums: '细项满分合计',
    category_detail_sums: '细项合计',
    anomalies: '评分异常',
    range_anomalies: '区间异常',
  }
  return labels[key] || key
}

function scoreTypeLabel(value) {
  return { fixed: '固定分', interval: '区间分', deduction: '扣分项', unknown: '待识别' }[value] || '待识别'
}

function scoreRule(item) {
  if (item?.score_type === 'interval') {
    const ranges = arrayify(item.ranges).map((range) => `${range.start}-${range.end} 分`).join('；')
    if (ranges) return ranges
  }
  if (item?.score_type === 'deduction') {
    return item?.deduction_rule?.text || (
      item?.deduction_rule?.max_deduction !== null && item?.deduction_rule?.max_deduction !== undefined
        ? `最多扣 ${item.deduction_rule.max_deduction} 分`
        : '扣分上限待复核'
    )
  }
  return item?.criteria || '--'
}

function PreviewModal({ value, onClose }) {
  const [preview, setPreview] = useState(null)
  const [page, setPage] = useState(Number(value?.evidence?.page || 1))
  const [pageInput, setPageInput] = useState(`${Number(value?.evidence?.page || 1)}`)
  const [zoom, setZoom] = useState(100)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadPage = useCallback(async (nextPage) => {
    const normalizedPage = Math.max(1, Number(nextPage || 1))
    setLoading(true)
    setError('')
    try {
      const evidence = value?.evidence || {}
      const onEvidencePage = Number(evidence.page || 0) === normalizedPage
      const result = await getDocumentPreview(value.documentId, normalizedPage, {
        highlight: onEvidencePage && evidence.text ? [evidence.text] : undefined,
        highlightBbox: onEvidencePage ? evidence.bbox : undefined,
        highlightCoordinateSpace: onEvidencePage ? (evidence.coordinate_system || 'pdf_point') : undefined,
      })
      setPreview(result)
      setPage(Number(result?.page || normalizedPage))
      setPageInput(`${Number(result?.page || normalizedPage)}`)
    } catch (requestError) {
      setError(requestError.message || '预览加载失败')
    } finally {
      setLoading(false)
    }
  }, [value])

  useEffect(() => {
    loadPage(Number(value?.evidence?.page || 1))
  }, [loadPage, value])

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const pageCount = Number(preview?.page_count || value?.pageCount || 1)

  return (
    <div className="tender-preview-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="tender-preview-modal" role="dialog" aria-modal="true" aria-label="问题定位预览">
        <header className="tender-preview-header">
          <div>
            <strong>{value?.title || '问题定位'}</strong>
            <span>{value?.fileName || ''}</span>
          </div>
          <button type="button" className="tender-icon-button" onClick={onClose} aria-label="关闭预览" title="关闭预览">×</button>
        </header>
        <div className="tender-preview-toolbar">
          <button type="button" onClick={() => loadPage(page - 1)} disabled={loading || page <= 1}>上一页</button>
          <form onSubmit={(event) => {
            event.preventDefault()
            loadPage(Math.min(pageCount, Math.max(1, Number(pageInput || 1))))
          }}>
            <input
              type="number"
              min="1"
              max={pageCount}
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              aria-label="预览页码"
            />
            <span>/ {pageCount}</span>
          </form>
          <button type="button" onClick={() => loadPage(page + 1)} disabled={loading || page >= pageCount}>下一页</button>
          <span className="tender-preview-toolbar-spacer" />
          <button type="button" onClick={() => setZoom((current) => Math.max(50, current - 10))} aria-label="缩小">−</button>
          <span>{zoom}%</span>
          <button type="button" onClick={() => setZoom((current) => Math.min(200, current + 10))} aria-label="放大">＋</button>
        </div>
        {value?.evidence?.text ? <p className="tender-preview-evidence">{value.evidence.text}</p> : null}
        <div className="tender-preview-canvas">
          {loading ? <div className="tender-preview-message">正在加载第 {page} 页...</div> : null}
          {error ? <div className="tender-preview-message tender-preview-message-error">{error}</div> : null}
          {!loading && !error && preview?.image_data_url ? (
            <img src={preview.image_data_url} alt={`第 ${page} 页预览`} style={{ width: `${zoom}%` }} />
          ) : null}
        </div>
      </section>
    </div>
  )
}

export default function TenderReviewPage() {
  const [file, setFile] = useState(null)
  const [history, setHistory] = useState([])
  const [historyPage, setHistoryPage] = useState(1)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [selectedReviewId, setSelectedReviewId] = useState('')
  const [detail, setDetail] = useState(null)
  const [filter, setFilter] = useState('all')
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [busyReviewId, setBusyReviewId] = useState('')
  const [notice, setNotice] = useState(null)
  const [previewTarget, setPreviewTarget] = useState(null)

  const loadHistory = useCallback(async (page = 1, preferredReviewId = '') => {
    setLoadingHistory(true)
    try {
      const listing = await listTenderReviews({ page, pageSize: PAGE_SIZE })
      const items = arrayify(listing?.items)
      setHistory(items)
      setHistoryPage(page)
      setHistoryTotal(Number(listing?.total || items.length))
      const nextId = preferredReviewId || items[0]?.review_id || ''
      if (nextId) setSelectedReviewId(nextId)
      if (!nextId) setDetail(null)
    } catch (error) {
      setNotice({ type: 'error', message: error.message || '审查历史加载失败' })
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  useEffect(() => {
    loadHistory(1)
  }, [loadHistory])

  useEffect(() => {
    if (!selectedReviewId) return undefined
    let active = true
    setLoadingDetail(true)
    getTenderReview(selectedReviewId)
      .then((result) => {
        if (active) setDetail(result)
      })
      .catch((error) => {
        if (active) setNotice({ type: 'error', message: error.message || '审查详情加载失败' })
      })
      .finally(() => {
        if (active) setLoadingDetail(false)
      })
    return () => { active = false }
  }, [selectedReviewId])

  const visibleChecks = useMemo(() => arrayify(detail?.checks).filter((check) => (
    filter === 'all' || check.status === filter
  )), [detail, filter])

  const totalPages = Math.max(1, Math.ceil(historyTotal / PAGE_SIZE))
  const detailStatus = statusMeta(detail?.summary?.overall_status || detail?.status)

  async function handleUpload() {
    if (!file || uploading) return
    if (!/\.pdf$/i.test(file.name || '')) {
      setNotice({ type: 'error', message: '招标文件审查仅支持 PDF 文件' })
      return
    }
    setUploading(true)
    setNotice(null)
    try {
      const result = await createTenderReview(file)
      setDetail(result)
      setSelectedReviewId(result.review_id)
      setFile(null)
      setFilter('all')
      setNotice({ type: 'success', message: '招标文件审查完成' })
      await loadHistory(1, result.review_id)
    } catch (error) {
      setNotice({ type: 'error', message: error.message || '招标文件审查失败' })
    } finally {
      setUploading(false)
    }
  }

  async function handleRerun() {
    if (!detail?.review_id || busyReviewId) return
    setBusyReviewId(detail.review_id)
    setNotice(null)
    try {
      const result = await rerunTenderReview(detail.review_id)
      setDetail(result)
      setNotice({ type: 'success', message: '重新审查完成' })
      await loadHistory(historyPage, detail.review_id)
    } catch (error) {
      setNotice({ type: 'error', message: error.message || '重新审查失败' })
    } finally {
      setBusyReviewId('')
    }
  }

  async function handleDelete() {
    if (!detail?.review_id || busyReviewId) return
    if (!window.confirm(`确认删除“${detail.document?.file_name || '该招标文件'}”的审查记录？`)) return
    setBusyReviewId(detail.review_id)
    try {
      await deleteTenderReview(detail.review_id)
      setSelectedReviewId('')
      setDetail(null)
      setNotice({ type: 'success', message: '审查记录已删除' })
      await loadHistory(1)
    } catch (error) {
      setNotice({ type: 'error', message: error.message || '删除审查记录失败' })
    } finally {
      setBusyReviewId('')
    }
  }

  function openEvidence(check, evidence) {
    if (!detail?.document?.identifier_id || !evidence?.page) return
    setPreviewTarget({
      documentId: detail.document.identifier_id,
      fileName: detail.document.file_name,
      pageCount: detail.document.page_count,
      title: check.title,
      evidence,
    })
  }

  return (
    <main className="tender-review-page">
      <header className="tender-review-titlebar">
        <div>
          <h2>招标文件审查</h2>
          <span>共享记录 {historyTotal} 份</span>
        </div>
      </header>

      {notice ? (
        <div className={`notice notice-${notice.type}`}>
          <p>{notice.message}</p>
          <button type="button" className="text-button" onClick={() => setNotice(null)}>关闭</button>
        </div>
      ) : null}

      <section className="panel tender-upload-panel">
        <FileUpload
          accept=".pdf,application/pdf"
          label="上传招标 PDF"
          fileName={file?.name}
          onChange={setFile}
        />
        <button type="button" className="primary-button" disabled={!file || uploading} onClick={handleUpload}>
          {uploading ? '解析审查中...' : '开始审查'}
        </button>
      </section>

      <div className="tender-review-layout">
        <aside className="panel tender-history-panel">
          <div className="tender-section-head">
            <h3>审查历史</h3>
            <button type="button" className="text-button" onClick={() => loadHistory(historyPage)} disabled={loadingHistory}>刷新</button>
          </div>
          <div className="tender-history-list">
            {loadingHistory ? <div className="tender-empty">正在加载...</div> : null}
            {!loadingHistory && history.length === 0 ? <div className="tender-empty">暂无审查记录</div> : null}
            {history.map((item) => {
              const meta = statusMeta(item.summary?.overall_status || item.status)
              return (
                <button
                  type="button"
                  className={`tender-history-item ${selectedReviewId === item.review_id ? 'tender-history-item-active' : ''}`}
                  key={item.review_id}
                  onClick={() => setSelectedReviewId(item.review_id)}
                >
                  <span className="tender-history-name">{item.document?.file_name || '未命名招标文件'}</span>
                  <span className="tender-history-meta">
                    <em className={`tender-status tender-status-${meta.tone}`}>{meta.label}</em>
                    {formatDateTime(item.updated_at)}
                  </span>
                </button>
              )
            })}
          </div>
          {historyTotal > PAGE_SIZE ? (
            <div className="tender-history-pagination">
              <button type="button" disabled={historyPage <= 1} onClick={() => loadHistory(historyPage - 1)}>上一页</button>
              <span>{historyPage} / {totalPages}</span>
              <button type="button" disabled={historyPage >= totalPages} onClick={() => loadHistory(historyPage + 1)}>下一页</button>
            </div>
          ) : null}
        </aside>

        <section className="tender-result-area">
          {loadingDetail ? <div className="panel tender-empty tender-detail-empty">正在加载审查结果...</div> : null}
          {!loadingDetail && !detail ? <div className="panel tender-empty tender-detail-empty">请选择或上传招标文件</div> : null}
          {!loadingDetail && detail ? (
            <>
              <section className="panel tender-result-header">
                <div className="tender-result-heading">
                  <div>
                    <h3>{detail.document?.file_name || '招标文件'}</h3>
                    <span>{formatBytes(detail.document?.file_size)} · {detail.document?.page_count || 0} 页 · {detail.document?.text_length || 0} 字</span>
                  </div>
                  <span className={`tender-status tender-status-${detailStatus.tone}`}>{detailStatus.label}</span>
                </div>
                <div className="tender-result-actions">
                  <button type="button" className="ghost-button" onClick={handleRerun} disabled={Boolean(busyReviewId)}>
                    {busyReviewId ? '处理中...' : '重新审查'}
                  </button>
                  <button type="button" className="tender-delete-button" onClick={handleDelete} disabled={Boolean(busyReviewId)}>删除</button>
                </div>
              </section>

              {detail.status === 'failed' ? (
                <div className="tender-failed-banner">{detail.error_message || '本次审查执行失败，可重新审查。'}</div>
              ) : (
                <>
                  <section className="tender-summary-grid">
                    <div><span>检查项</span><strong>{detail.summary?.total || 0}</strong></div>
                    <div><span>通过</span><strong>{detail.summary?.passed || 0}</strong></div>
                    <div><span>异常</span><strong>{detail.summary?.failed || 0}</strong></div>
                    <div><span>待复核</span><strong>{detail.summary?.unclear || 0}</strong></div>
                  </section>

                  <div className="tender-filter-tabs" role="tablist" aria-label="审查结果筛选">
                    {FILTERS.map((item) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={filter === item.key}
                        className={filter === item.key ? 'tender-filter-active' : ''}
                        key={item.key}
                        onClick={() => setFilter(item.key)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>

                  <div className="tender-check-list">
                    {visibleChecks.length === 0 ? <div className="panel tender-empty">当前筛选下暂无检查项</div> : null}
                    {visibleChecks.map((check) => {
                      const meta = statusMeta(check.status)
                      const evidenceItems = arrayify(check.evidence)
                      const valueEntries = Object.entries(check.values || {}).filter(([key, value]) => (
                        key !== 'scoring_items' && value !== null && value !== undefined && value !== ''
                      ))
                      const scoringItems = arrayify(check.values?.scoring_items)
                      return (
                        <article className={`tender-check tender-check-${meta.tone}`} key={check.code}>
                          <header>
                            <div>
                              <strong>{check.title}</strong>
                              <p>{check.message}</p>
                            </div>
                            <span className={`tender-status tender-status-${meta.tone}`}>{meta.label}</span>
                          </header>
                          {valueEntries.length ? (
                            <div className="tender-value-list">
                              {valueEntries.slice(0, 8).map(([key, value]) => (
                                <span key={key}>{valueLabel(key)}：{formatCompactValue(value)}</span>
                              ))}
                            </div>
                          ) : null}
                          {scoringItems.length ? (
                            <div className="tender-score-table-wrap">
                              <table className="tender-score-table">
                                <thead><tr><th>大类</th><th>评分项</th><th>类型</th><th>满分</th><th>规则</th><th>结果</th></tr></thead>
                                <tbody>
                                  {scoringItems.map((item, index) => {
                                    const itemMeta = statusMeta(item.status)
                                    return (
                                      <tr key={`${item.category || 'unknown'}-${item.item_name || index}-${index}`}>
                                        <td>{item.category_label || '--'}</td>
                                        <td>{item.item_name || '--'}</td>
                                        <td>{scoreTypeLabel(item.score_type)}</td>
                                        <td>{item.item_max_score ?? '--'}</td>
                                        <td>{scoreRule(item)}</td>
                                        <td><span className={`tender-status tender-status-${itemMeta.tone}`}>{itemMeta.label}</span></td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          ) : null}
                          {check.status !== 'pass' ? (
                            <div className="tender-evidence-list">
                              {evidenceItems.length === 0 ? <span>暂无可定位证据</span> : null}
                              {evidenceItems.slice(0, 6).map((evidence, index) => (
                                <div key={`${check.code}-${evidence.page || 'none'}-${index}`}>
                                  <p>{evidence.text || '原文位置'}</p>
                                  <button type="button" disabled={!evidence.page} onClick={() => openEvidence(check, evidence)}>
                                    {evidence.page ? `定位第 ${evidence.page} 页` : '无法定位'}
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </article>
                      )
                    })}
                  </div>
                </>
              )}
            </>
          ) : null}
        </section>
      </div>

      {previewTarget ? <PreviewModal value={previewTarget} onClose={() => setPreviewTarget(null)} /> : null}
    </main>
  )
}
