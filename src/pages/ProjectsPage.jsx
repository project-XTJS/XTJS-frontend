import { startTransition, useCallback, useEffect, useState } from 'react'
import {
  continueTechnicalOcr,
  deleteProject,
  getProjectDetail,
  ingestProjectDocuments,
  listProjects,
  runBusinessOcr,
  runTenderOcr,
} from '../lib/xtjsApi'
import {
  deriveBidderName,
  deriveProjectTitle,
  formatDateTime,
  getParsingProgress,
  getProjectStatus,
  getProjectSummary,
  stripExtension,
} from '../utils/formatters'
import StatusPill from '../components/StatusPill'
import StatItem from '../components/StatItem'
import EmptyBlock from '../components/EmptyBlock'
import FileUpload from '../components/FileUpload'

function createBidGroupDraft() {
  return {
    id: `group-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    businessFile: null,
    technicalFile: null,
  }
}

function createInitialComposer() {
  return {
    projectName: '',
    tenderFile: null,
    bidGroupParallelism: 1,
    bidGroups: [createBidGroupDraft()],
  }
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

function getProjectName(project) {
  return project?.project_name || project?.projectName || project?.identifier_id || project?.id || ''
}

function getProjectIdentifier(project) {
  return project?.identifier_id || project?.id || project?.project_name || project?.projectName || ''
}

function normalizeProject(detail) {
  const relations = (detail.relations ?? []).map(normalizeRelation)
  const projectName = getProjectName(detail.project)
  const identifierId = getProjectIdentifier(detail.project)

  return {
    id: identifierId,
    identifierId,
    projectName,
    title: projectName || deriveProjectTitle(identifierId, relations),
    createdAt: detail.project.create_time,
    updatedAt: detail.project.update_time,
    parsingStatus: detail.project.parsing_status ?? 0,
    relations,
    results: {},
  }
}

function normalizeProjectFromListItem(item) {
  const projectName = getProjectName(item)
  const identifierId = getProjectIdentifier(item)

  return {
    id: identifierId,
    identifierId,
    projectName,
    title: projectName || identifierId,
    createdAt: item.create_time,
    updatedAt: item.update_time,
    parsingStatus: item.parsing_status ?? 0,
    relations: [],
    results: {},
  }
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [searchText, setSearchText] = useState('')
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const [composer, setComposer] = useState(createInitialComposer)
  const [notice, setNotice] = useState(null)
  const [isLoadingProjects, setIsLoadingProjects] = useState(true)
  const [busyToken, setBusyToken] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState('')

  const loadProjects = useCallback(async () => {
    setIsLoadingProjects(true)
    setNotice(null)

    try {
      const listing = await listProjects({ pageSize: 24 })
      const detailResults = await Promise.allSettled(
        (listing.items ?? []).map((item) => getProjectDetail(getProjectIdentifier(item))),
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
              results: existing?.results ?? project.results,
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
      setNotice({
        type: 'error',
        message: error.message || '项目列表加载失败。',
      })
    } finally {
      setIsLoadingProjects(false)
    }
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  const filteredProjects = projects.filter((project) => {
    const keyword = searchText.trim().toLowerCase()
    if (!keyword) return true
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

  const canSubmitComposer =
    Boolean(composer.projectName.trim()) &&
    Boolean(composer.tenderFile) &&
    composer.bidGroups.length > 0 &&
    composer.bidGroups.every((group) => group.businessFile && group.technicalFile)

  function updateComposerField(field, value) {
    setComposer((current) => ({ ...current, [field]: value }))
  }

  function updateBidGroup(groupId, field, value) {
    setComposer((current) => ({
      ...current,
      bidGroups: current.bidGroups.map((group) =>
        group.id === groupId ? { ...group, [field]: value } : group,
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

  async function handleCreateProject() {
    if (!canSubmitComposer) return

    setBusyToken('create-project')
    setNotice(null)

    try {
      const businessBidFiles = composer.bidGroups.map((g) => g.businessFile)
      const technicalBidFiles = composer.bidGroups.map((g) => g.technicalFile)

      const payload = await ingestProjectDocuments({
        projectName: composer.projectName.trim(),
        bidGroupParallelism: composer.bidGroupParallelism,
        tenderFile: composer.tenderFile,
        businessBidFiles,
        technicalBidFiles,
      })

      const projectId = getProjectIdentifier(payload.project)
      const projectName = getProjectName(payload.project) || composer.projectName.trim()

      let nextProject
      try {
        nextProject = normalizeProject(await getProjectDetail(projectId))
      } catch {
        nextProject = {
          id: projectId,
          identifierId: projectId,
          projectName,
          title: projectName || (composer.tenderFile?.name
            ? stripExtension(composer.tenderFile.name)
            : projectId),
          createdAt: payload.project?.create_time ?? new Date().toISOString(),
          updatedAt: payload.project?.update_time ?? new Date().toISOString(),
          relations: [],
          results: {},
        }
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
        type: 'info',
        message: `项目 ${projectId} 创建成功，正在启动 OCR 解析...`,
      })

      // 异步触发 OCR（招标文件 → 商务标 → 技术标）
      const ocrResults = []
      try {
        ocrResults.push(await runTenderOcr(projectId, { parallelism: composer.bidGroupParallelism }))
      } catch (e) {
        ocrResults.push({ error: e.message })
      }
      try {
        ocrResults.push(await runBusinessOcr(projectId, { parallelism: composer.bidGroupParallelism }))
      } catch (e) {
        ocrResults.push({ error: e.message })
      }
      try {
        ocrResults.push(await continueTechnicalOcr(projectId, { parallelism: composer.bidGroupParallelism }))
      } catch (e) {
        ocrResults.push({ error: e.message })
      }

      const ocrFailed = ocrResults.some((r) => r?.error)
      setNotice({
        type: ocrFailed ? 'warning' : 'success',
        message: ocrFailed
          ? `项目 ${projectId} 创建成功，部分 OCR 触发失败，请手动重试。`
          : `项目 ${projectId} 创建成功，OCR 解析已全部启动。`,
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

  async function handleDeleteProject() {
    if (!activeProject || deleteConfirm !== activeProject.identifierId) {
      setDeleteConfirm(activeProject?.identifierId ?? '')
      return
    }

    setBusyToken('delete-project')
    setNotice(null)

    try {
      await deleteProject(activeProject.identifierId)
      startTransition(() => {
        setProjects((current) => current.filter((item) => item.id !== activeProject.id))
        setSelectedProjectId('')
        setDeleteConfirm('')
      })
      setNotice({ type: 'success', message: '项目已删除。' })
    } catch (error) {
      setNotice({ type: 'error', message: error.message || '删除项目失败。' })
    } finally {
      setBusyToken('')
    }
  }

  const DOCUMENT_LABELS = {
    tender: '招标文件',
    business_bid: '商务标',
    technical_bid: '技术标',
  }

  return (
    <>
      {notice ? (
        <div className={`notice notice-${notice.type}`}>
          <p>{notice.message}</p>
        </div>
      ) : null}

      {isComposerOpen ? (
        <section className="panel create-panel">
          <div className="panel-header">
            <h2>新建项目</h2>
            <button
              type="button"
              className="text-button"
              onClick={() => setIsComposerOpen(false)}
            >
              收起
            </button>
          </div>

          <div className="create-grid">
            <label className="field">
              <span>项目名称</span>
              <input
                value={composer.projectName}
                onChange={(event) => updateComposerField('projectName', event.target.value)}
                placeholder="输入项目名称"
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

            <div className="field field-wide">
              <span>招标文件</span>
              <FileUpload
                accept=".pdf"
                onChange={(file) => updateComposerField('tenderFile', file)}
                fileName={composer.tenderFile?.name}
                label="拖拽或点击上传招标文件"
              />
            </div>
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
                  <div className="field">
                    <span>商务标</span>
                    <FileUpload
                      accept=".pdf"
                      onChange={(file) => updateBidGroup(group.id, 'businessFile', file)}
                      fileName={group.businessFile?.name}
                      label="上传商务标"
                    />
                  </div>

                  <div className="field">
                    <span>技术标</span>
                    <FileUpload
                      accept=".pdf"
                      onChange={(file) => updateBidGroup(group.id, 'technicalFile', file)}
                      fileName={group.technicalFile?.name}
                      label="上传技术标"
                    />
                  </div>
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
              {busyToken === 'create-project' ? '提交中...' : '创建并开始解析'}
            </button>
          </div>
        </section>
      ) : null}

      <main className="layout">
        <aside className="panel sidebar">
          <div className="panel-header">
            <h2>项目列表</h2>
            <button
              type="button"
              className="primary-button"
              onClick={() => setIsComposerOpen(true)}
            >
              新建项目
            </button>
          </div>

          <label className="search-field">
            <input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索项目..."
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
                    onClick={() => {
                      setSelectedProjectId(project.id)
                      setDeleteConfirm('')
                    }}
                  >
                    <div className="project-card-head">
                      <strong>{project.title}</strong>
                      <StatusPill label={status.label} className={status.className} />
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
                  <StatusPill
                    label={getProjectStatus(activeProject).label}
                    className={getProjectStatus(activeProject).className}
                  />
                </div>

                <div className="stats-grid">
                  <StatItem label="项目标识" value={activeProject.identifierId} />
                  <StatItem label="创建时间" value={formatDateTime(activeProject.createdAt)} />
                  <StatItem label="更新时间" value={formatDateTime(activeProject.updatedAt)} />
                  <StatItem label="标书组数" value={activeProject.relations.length} />
                  <StatItem
                    label="分析状态"
                    value={getProjectStatus(activeProject).label}
                  />
                </div>

                <div className="parsing-progress">
                  <div className="parsing-progress-bar">
                    <div
                      className="parsing-progress-fill"
                      style={{ width: `${getParsingProgress(activeProject.parsingStatus).percent}%` }}
                    />
                  </div>
                  <span>{getParsingProgress(activeProject.parsingStatus).label}</span>
                </div>

                <div className="action-row">
                  {deleteConfirm === activeProject.identifierId ? (
                    <>
                      <span className="confirm-text">确认删除此项目？</span>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => setDeleteConfirm('')}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary-button danger-button"
                        onClick={handleDeleteProject}
                        disabled={busyToken === 'delete-project'}
                      >
                        {busyToken === 'delete-project' ? '删除中...' : '确认删除'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => setDeleteConfirm(activeProject.identifierId)}
                      >
                        删除项目
                      </button>
                      <a href={`#/analysis?projectId=${activeProject.identifierId}`} className="primary-button">
                        进入分析中心 →
                      </a>
                    </>
                  )}
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
                          {[relation.tenderFile, relation.businessFile, relation.technicalFile].map(
                            (file) => (
                              <div className="file-card" key={file.identifierId}>
                                <span>{DOCUMENT_LABELS[file.documentType]}</span>
                                <strong>{file.fileName}</strong>
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyBlock title="当前项目暂无文档关系" />
                )}
              </section>
            </>
          ) : (
            <section className="panel empty-panel">
              <EmptyBlock title={isLoadingProjects ? '项目加载中...' : '选择一个项目查看详情'} />
            </section>
          )}
        </section>
      </main>
    </>
  )
}
