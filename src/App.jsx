import { startTransition, useCallback, useEffect, useState } from 'react'
import './App.css'
import {
  batchRecognizeProjectDocuments,
  getProjectDetail,
  listProjects,
  probeBackend,
  runBidDocumentReview,
  runDuplicateCheck,
} from './lib/xtjsApi'

const DOCUMENT_SCOPE_OPTIONS = [
  { value: 'all', label: '全部标书' },
  { value: 'business_bid', label: '仅商务标' },
  { value: 'technical_bid', label: '仅技术标' },
]

const DOCUMENT_LABELS = {
  tender: '招标文件',
  business_bid: '商务标',
  technical_bid: '技术标',
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

function createBidGroupDraft() {
  return {
    id: `group-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    businessFile: null,
    technicalFile: null,
  }
}

function createInitialComposer() {
  return {
    projectIdentifier: '',
    tenderFile: null,
    bidGroupParallelism: 4,
    bidGroups: [createBidGroupDraft()],
  }
}

function stripExtension(fileName) {
  return String(fileName || '').replace(/\.[^.]+$/, '')
}

function formatDateTime(value) {
  if (!value) {
    return '--'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return dateFormatter.format(date).replace(/\//g, '-')
}

function deriveBidderName(fileName) {
  return stripExtension(fileName)
    .replace(/(商务标|技术标|投标文件|扫描件|商务|技术)/g, '')
    .replace(/[()（）_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function deriveProjectTitle(identifierId, relations) {
  const tenderFileName = relations[0]?.tenderFile?.fileName
  return tenderFileName ? stripExtension(tenderFileName) : identifierId
}

function normalizeRelation(rawRelation, index) {
  return {
    id: rawRelation.relation_id ?? index + 1,
    createdAt: rawRelation.create_time ?? '',
    tenderFile: {
      identifierId: rawRelation.tender_identifier_id,
      documentType: 'tender',
      fileName: rawRelation.tender_file_name,
      fileUrl: rawRelation.tender_file_url,
    },
    businessFile: {
      identifierId: rawRelation.business_bid_identifier_id,
      documentType: 'business_bid',
      fileName: rawRelation.business_bid_file_name,
      fileUrl: rawRelation.business_bid_file_url,
      bidderName: deriveBidderName(rawRelation.business_bid_file_name),
    },
    technicalFile: {
      identifierId: rawRelation.technical_bid_identifier_id,
      documentType: 'technical_bid',
      fileName: rawRelation.technical_bid_file_name,
      fileUrl: rawRelation.technical_bid_file_url,
      bidderName: deriveBidderName(rawRelation.technical_bid_file_name),
    },
  }
}

function normalizeProject(detail) {
  const relations = (detail.relations ?? []).map(normalizeRelation)

  return {
    id: detail.project.identifier_id,
    identifierId: detail.project.identifier_id,
    title: deriveProjectTitle(detail.project.identifier_id, relations),
    createdAt: detail.project.create_time,
    updatedAt: detail.project.update_time,
    relations,
    results: {
      duplicateCheck: null,
      bidDocumentReview: null,
    },
  }
}

function normalizeProjectFromListItem(item) {
  return {
    id: item.identifier_id,
    identifierId: item.identifier_id,
    title: item.identifier_id,
    createdAt: item.create_time,
    updatedAt: item.update_time,
    relations: [],
    results: {
      duplicateCheck: null,
      bidDocumentReview: null,
    },
  }
}

function createDetailFromBatchPayload(payload) {
  return {
    project: payload.project,
    relations: (payload.bid_groups?.items ?? [])
      .filter((item) => item.status === 'success' && item.relation)
      .map((item) => item.relation),
  }
}

function getProjectStatus(project) {
  const duplicateSummary = project.results.duplicateCheck?.summary
  const reviewSummary = project.results.bidDocumentReview?.summary
  const hasRelations = project.relations.length > 0
  const hasResult = Boolean(project.results.duplicateCheck || project.results.bidDocumentReview)
  const hasRisk = Boolean(
    (duplicateSummary?.suspicious_pair_count ?? 0) > 0 ||
      reviewSummary?.suspicious ||
      (reviewSummary?.reused_name_count ?? 0) > 0,
  )

  if (!hasRelations) {
    return { label: '待绑定', className: 'status-pending' }
  }

  if (hasRisk) {
    return { label: '需复核', className: 'status-risk' }
  }

  if (project.results.duplicateCheck && project.results.bidDocumentReview) {
    return { label: '已完成', className: 'status-success' }
  }

  if (hasResult) {
    return { label: '处理中', className: 'status-running' }
  }

  return { label: '待处理', className: 'status-ready' }
}

function getProjectSummary(project) {
  const status = getProjectStatus(project)

  if (status.className === 'status-pending') {
    return '尚未形成完整文档关系'
  }

  if (status.className === 'status-risk') {
    return '已发现可疑项，建议人工复核'
  }

  if (status.className === 'status-success') {
    return '查重与审查均已完成'
  }

  if (status.className === 'status-running') {
    return '已有部分审查结果'
  }

  return '可以发起查重或标书审查'
}

function collectDuplicateAlerts(result) {
  if (!result?.groups) {
    return []
  }

  const order = { high: 3, medium: 2, low: 1, none: 0 }

  return Object.entries(result.groups)
    .flatMap(([groupKey, groupValue]) =>
      (groupValue.items ?? [])
        .filter((item) => item.suspicious)
        .map((item) => ({
          id: `${groupKey}-${item.left_document_identifier}-${item.right_document_identifier}`,
          groupLabel: DOCUMENT_LABELS[groupKey] ?? groupKey,
          riskLevel: item.risk_level ?? 'none',
          title: `${item.left_file_name} / ${item.right_file_name}`,
          description: `匹配得分 ${item.exact_match_score}，块重合 ${item.metrics?.exact_block_overlap_ratio ?? 0}`,
        })),
    )
    .sort((left, right) => (order[right.riskLevel] ?? 0) - (order[left.riskLevel] ?? 0))
}

function collectReviewAlerts(result) {
  if (!result?.groups) {
    return []
  }

  return Object.entries(result.groups).flatMap(([groupKey, groupValue]) => {
    const typoAlerts = (groupValue.typo_check?.documents ?? []).map((item) => ({
      id: `typo-${groupKey}-${item.identifier_id}`,
      groupLabel: DOCUMENT_LABELS[groupKey] ?? groupKey,
      title: item.file_name,
      description: `${item.issue_count} 条错字风险`,
    }))

    const personnelAlerts = (groupValue.personnel_reuse_check?.items ?? []).map((item) => ({
      id: `personnel-${groupKey}-${item.name}`,
      groupLabel: DOCUMENT_LABELS[groupKey] ?? groupKey,
      title: item.name,
      description: `${item.document_count} 份文档重复出现`,
    }))

    return [...typoAlerts, ...personnelAlerts]
  })
}

function StatItem({ label, value }) {
  return (
    <div className="stat-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function EmptyBlock({ title }) {
  return (
    <div className="empty-block">
      <p>{title}</p>
    </div>
  )
}

function App() {
  const [projects, setProjects] = useState([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [searchText, setSearchText] = useState('')
  const [activeScope, setActiveScope] = useState('all')
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const [composer, setComposer] = useState(createInitialComposer)
  const [connection, setConnection] = useState({
    status: 'loading',
    message: '正在连接接口',
  })
  const [notice, setNotice] = useState(null)
  const [isLoadingProjects, setIsLoadingProjects] = useState(true)
  const [busyToken, setBusyToken] = useState('')

  const loadProjects = useCallback(async () => {
    setIsLoadingProjects(true)
    setNotice(null)

    try {
      await probeBackend()
      const listing = await listProjects({ limit: 24, offset: 0 })
      const detailResults = await Promise.allSettled(
        (listing.items ?? []).map((item) => getProjectDetail(item.identifier_id)),
      )

      const nextProjects = detailResults.map((result, index) =>
        result.status === 'fulfilled'
          ? normalizeProject(result.value)
          : normalizeProjectFromListItem(listing.items[index]),
      )

      startTransition(() => {
        setProjects((current) =>
          nextProjects.map((project) => {
            const existing = current.find((item) => item.id === project.id)

            return {
              ...project,
              results: {
                duplicateCheck: existing?.results.duplicateCheck ?? null,
                bidDocumentReview: existing?.results.bidDocumentReview ?? null,
              },
            }
          }),
        )
        setSelectedProjectId((current) => {
          if (current && nextProjects.some((item) => item.id === current)) {
            return current
          }

          return nextProjects[0]?.id ?? ''
        })
      })

      setConnection({
        status: 'success',
        message: 'API 已连接',
      })

      if (detailResults.some((item) => item.status === 'rejected')) {
        setNotice({
          type: 'warning',
          message: '部分项目详情加载失败，已先展示项目列表数据。',
        })
      }
    } catch (error) {
      startTransition(() => {
        setProjects([])
        setSelectedProjectId('')
      })
      setConnection({
        status: 'error',
        message: 'API 连接失败',
      })
      setNotice({
        type: 'error',
        message: error.message || '项目列表加载失败。',
      })
    } finally {
      setIsLoadingProjects(false)
    }
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const filteredProjects = projects.filter((project) => {
    const keyword = searchText.trim().toLowerCase()

    if (!keyword) {
      return true
    }

    return [project.title, project.identifierId]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword))
  })

  const activeProject =
    filteredProjects.find((item) => item.id === selectedProjectId) ??
    projects.find((item) => item.id === selectedProjectId) ??
    filteredProjects[0] ??
    projects[0] ??
    null

  const duplicateAlerts = collectDuplicateAlerts(activeProject?.results.duplicateCheck)
  const reviewAlerts = collectReviewAlerts(activeProject?.results.bidDocumentReview)

  const canSubmitComposer =
    Boolean(composer.tenderFile) &&
    composer.bidGroups.length > 0 &&
    composer.bidGroups.every((group) => group.businessFile && group.technicalFile)

  function updateComposerField(field, value) {
    setComposer((current) => ({
      ...current,
      [field]: value,
    }))
  }

  function updateBidGroup(groupId, field, value) {
    setComposer((current) => ({
      ...current,
      bidGroups: current.bidGroups.map((group) =>
        group.id === groupId
          ? {
              ...group,
              [field]: value,
            }
          : group,
      ),
    }))
  }

  function appendBidGroup() {
    setComposer((current) => ({
      ...current,
      bidGroups: [...current.bidGroups, createBidGroupDraft()],
    }))
  }

  function removeBidGroup(groupId) {
    setComposer((current) => ({
      ...current,
      bidGroups:
        current.bidGroups.length === 1
          ? current.bidGroups
          : current.bidGroups.filter((group) => group.id !== groupId),
    }))
  }

  async function refreshProjectDetail(identifierId) {
    const detail = await getProjectDetail(identifierId)
    return normalizeProject(detail)
  }

  async function handleCreateProject() {
    if (!canSubmitComposer) {
      return
    }

    setBusyToken('create-project')
    setNotice(null)

    try {
      const payload = await batchRecognizeProjectDocuments({
        projectIdentifier: composer.projectIdentifier,
        bidGroupParallelism: composer.bidGroupParallelism,
        tenderFile: composer.tenderFile,
        bidGroups: composer.bidGroups,
      })

      let nextProject

      try {
        nextProject = await refreshProjectDetail(payload.project.identifier_id)
      } catch {
        nextProject = normalizeProject(createDetailFromBatchPayload(payload))
      }

      startTransition(() => {
        setProjects((current) => [
          nextProject,
          ...current.filter((item) => item.id !== nextProject.id),
        ])
        setSelectedProjectId(nextProject.id)
        setComposer(createInitialComposer())
        setIsComposerOpen(false)
      })

      setNotice({
        type: 'success',
        message: `项目 ${payload.project.identifier_id} 创建成功。`,
      })
      setConnection({
        status: 'success',
        message: 'API 已连接',
      })
    } catch (error) {
      setNotice({
        type: 'error',
        message: error.message || '创建项目失败。',
      })
    } finally {
      setBusyToken('')
    }
  }

  async function handleRunDuplicateCheck() {
    if (!activeProject) {
      return
    }

    setBusyToken(`duplicate-${activeProject.id}`)
    setNotice(null)

    try {
      const result = await runDuplicateCheck({
        identifierId: activeProject.identifierId,
        documentScope: activeScope,
      })

      startTransition(() => {
        setProjects((current) =>
          current.map((project) =>
            project.id === activeProject.id
              ? {
                  ...project,
                  results: {
                    ...project.results,
                    duplicateCheck: result,
                  },
                }
              : project,
          ),
        )
      })

      setNotice({
        type: 'success',
        message: '查重完成。',
      })
    } catch (error) {
      setNotice({
        type: 'error',
        message: error.message || '查重失败。',
      })
    } finally {
      setBusyToken('')
    }
  }

  async function handleRunBidReview() {
    if (!activeProject) {
      return
    }

    setBusyToken(`review-${activeProject.id}`)
    setNotice(null)

    try {
      const result = await runBidDocumentReview({
        identifierId: activeProject.identifierId,
        documentScope: activeScope,
      })

      startTransition(() => {
        setProjects((current) =>
          current.map((project) =>
            project.id === activeProject.id
              ? {
                  ...project,
                  results: {
                    ...project.results,
                    bidDocumentReview: result,
                  },
                }
              : project,
          ),
        )
      })

      setNotice({
        type: 'success',
        message: '标书审查完成。',
      })
    } catch (error) {
      setNotice({
        type: 'error',
        message: error.message || '标书审查失败。',
      })
    } finally {
      setBusyToken('')
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>信投建设智能审标平台</h1>
        <div className="topbar-actions">
          <span className={`connection-badge ${connection.status}`}>{connection.message}</span>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void loadProjects()}
            disabled={isLoadingProjects}
          >
            {isLoadingProjects ? '刷新中...' : '刷新'}
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => setIsComposerOpen((current) => !current)}
          >
            {isComposerOpen ? '收起新建' : '新建项目'}
          </button>
        </div>
      </header>

      {notice ? (
        <div className={`notice notice-${notice.type}`}>
          <p>{notice.message}</p>
        </div>
      ) : null}

      {isComposerOpen ? (
        <section className="panel create-panel">
          <div className="panel-header">
            <h2>新建项目</h2>
          </div>

          <div className="create-grid">
            <label className="field">
              <span>项目标识</span>
              <input
                value={composer.projectIdentifier}
                onChange={(event) => updateComposerField('projectIdentifier', event.target.value)}
                placeholder="可选，不填则由后端生成"
              />
            </label>

            <label className="field">
              <span>并行组数</span>
              <input
                type="number"
                min="1"
                max="16"
                value={composer.bidGroupParallelism}
                onChange={(event) =>
                  updateComposerField('bidGroupParallelism', Number(event.target.value) || 1)
                }
              />
            </label>

            <label className="field field-wide">
              <span>招标文件</span>
              <input
                type="file"
                onChange={(event) => updateComposerField('tenderFile', event.target.files?.[0] ?? null)}
              />
              <small>{composer.tenderFile?.name ?? '未选择文件'}</small>
            </label>
          </div>

          <div className="group-toolbar">
            <h3>标书组</h3>
            <button type="button" className="ghost-button" onClick={appendBidGroup}>
              添加一组
            </button>
          </div>

          <div className="group-list">
            {composer.bidGroups.map((group, index) => (
              <div className="group-card" key={group.id}>
                <div className="group-card-head">
                  <strong>标书组 {index + 1}</strong>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => removeBidGroup(group.id)}
                    disabled={composer.bidGroups.length === 1}
                  >
                    删除
                  </button>
                </div>

                <div className="create-grid">
                  <label className="field">
                    <span>商务标</span>
                    <input
                      type="file"
                      onChange={(event) =>
                        updateBidGroup(group.id, 'businessFile', event.target.files?.[0] ?? null)
                      }
                    />
                    <small>{group.businessFile?.name ?? '未选择文件'}</small>
                  </label>

                  <label className="field">
                    <span>技术标</span>
                    <input
                      type="file"
                      onChange={(event) =>
                        updateBidGroup(group.id, 'technicalFile', event.target.files?.[0] ?? null)
                      }
                    />
                    <small>{group.technicalFile?.name ?? '未选择文件'}</small>
                  </label>
                </div>
              </div>
            ))}
          </div>

          <div className="panel-footer">
            <button
              type="button"
              className="primary-button"
              onClick={handleCreateProject}
              disabled={!canSubmitComposer || busyToken === 'create-project'}
            >
              {busyToken === 'create-project' ? '提交中...' : '创建项目'}
            </button>
          </div>
        </section>
      ) : null}

      <main className="layout">
        <aside className="panel sidebar">
          <div className="panel-header">
            <h2>项目列表</h2>
          </div>

          <label className="search-field">
            <input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索项目"
            />
          </label>

          <div className="project-list">
            {filteredProjects.length > 0 ? (
              filteredProjects.map((project) => {
                const status = getProjectStatus(project)

                return (
                  <button
                    type="button"
                    key={project.id}
                    className={`project-card ${activeProject?.id === project.id ? 'is-active' : ''}`}
                    onClick={() => setSelectedProjectId(project.id)}
                  >
                    <div className="project-card-head">
                      <strong>{project.title}</strong>
                      <span className={`status-pill ${status.className}`}>{status.label}</span>
                    </div>
                    <p>{project.identifierId}</p>
                    <div className="project-card-foot">
                      <span>{project.relations.length} 组标书</span>
                      <span>{formatDateTime(project.updatedAt)}</span>
                    </div>
                    <small>{getProjectSummary(project)}</small>
                  </button>
                )
              })
            ) : (
              <EmptyBlock title={isLoadingProjects ? '项目加载中...' : '暂无项目'} />
            )}
          </div>
        </aside>

        <section className="content">
          {activeProject ? (
            <>
              <section className="panel summary-panel">
                <div className="summary-head">
                  <div>
                    <h2>{activeProject.title}</h2>
                    <p>{activeProject.identifierId}</p>
                  </div>
                  <span className={`status-pill ${getProjectStatus(activeProject).className}`}>
                    {getProjectStatus(activeProject).label}
                  </span>
                </div>

                <div className="stats-grid">
                  <StatItem label="项目标识" value={activeProject.identifierId} />
                  <StatItem label="标书组数" value={activeProject.relations.length} />
                  <StatItem label="更新时间" value={formatDateTime(activeProject.updatedAt)} />
                </div>

                <div className="action-row">
                  <label className="scope-field">
                    <span>执行范围</span>
                    <select value={activeScope} onChange={(event) => setActiveScope(event.target.value)}>
                      {DOCUMENT_SCOPE_OPTIONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="action-buttons">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={handleRunDuplicateCheck}
                      disabled={busyToken === `duplicate-${activeProject.id}`}
                    >
                      {busyToken === `duplicate-${activeProject.id}` ? '查重中...' : '执行查重'}
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={handleRunBidReview}
                      disabled={busyToken === `review-${activeProject.id}`}
                    >
                      {busyToken === `review-${activeProject.id}` ? '审查中...' : '执行审查'}
                    </button>
                  </div>
                </div>
              </section>

              <section className="panel relation-panel">
                <div className="panel-header">
                  <h2>文档关系</h2>
                </div>

                {activeProject.relations.length > 0 ? (
                  <div className="relation-list">
                    {activeProject.relations.map((relation, index) => (
                      <div className="relation-card" key={relation.id}>
                        <div className="relation-card-head">
                          <strong>标书组 {index + 1}</strong>
                          <span>{formatDateTime(relation.createdAt)}</span>
                        </div>

                        <div className="relation-files">
                          {[relation.tenderFile, relation.businessFile, relation.technicalFile].map((file) => (
                            <div className="file-card" key={file.identifierId}>
                              <span>{DOCUMENT_LABELS[file.documentType]}</span>
                              <strong>{file.fileName}</strong>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyBlock title="当前项目暂无文档关系" />
                )}
              </section>

              <section className="results-grid">
                <div className="panel result-panel">
                  <div className="panel-header">
                    <h2>文档查重</h2>
                  </div>

                  {activeProject.results.duplicateCheck ? (
                    <>
                      <div className="stats-grid compact">
                        <StatItem
                          label="文档数"
                          value={activeProject.results.duplicateCheck.summary?.document_count ?? 0}
                        />
                        <StatItem
                          label="比对对数"
                          value={activeProject.results.duplicateCheck.summary?.pair_count ?? 0}
                        />
                        <StatItem
                          label="可疑对数"
                          value={activeProject.results.duplicateCheck.summary?.suspicious_pair_count ?? 0}
                        />
                      </div>

                      {duplicateAlerts.length > 0 ? (
                        <div className="alert-list">
                          {duplicateAlerts.slice(0, 6).map((item) => (
                            <div className="alert-card" key={item.id}>
                              <div className="alert-card-head">
                                <strong>{item.title}</strong>
                                <span className="alert-tag">{item.groupLabel}</span>
                              </div>
                              <p>{item.description}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <EmptyBlock title="暂无可疑重复" />
                      )}
                    </>
                  ) : (
                    <EmptyBlock title="尚未执行查重" />
                  )}
                </div>

                <div className="panel result-panel">
                  <div className="panel-header">
                    <h2>标书审查</h2>
                  </div>

                  {activeProject.results.bidDocumentReview ? (
                    <>
                      <div className="stats-grid compact">
                        <StatItem
                          label="文档数"
                          value={activeProject.results.bidDocumentReview.summary?.document_count ?? 0}
                        />
                        <StatItem
                          label="错字问题"
                          value={activeProject.results.bidDocumentReview.summary?.typo_issue_count ?? 0}
                        />
                        <StatItem
                          label="人员复用"
                          value={activeProject.results.bidDocumentReview.summary?.reused_name_count ?? 0}
                        />
                      </div>

                      {reviewAlerts.length > 0 ? (
                        <div className="alert-list">
                          {reviewAlerts.slice(0, 6).map((item) => (
                            <div className="alert-card" key={item.id}>
                              <div className="alert-card-head">
                                <strong>{item.title}</strong>
                                <span className="alert-tag">{item.groupLabel}</span>
                              </div>
                              <p>{item.description}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <EmptyBlock title="暂无审查异常" />
                      )}
                    </>
                  ) : (
                    <EmptyBlock title="尚未执行标书审查" />
                  )}
                </div>
              </section>
            </>
          ) : (
            <section className="panel empty-panel">
              <EmptyBlock title={isLoadingProjects ? '项目加载中...' : '暂无可展示项目'} />
            </section>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
