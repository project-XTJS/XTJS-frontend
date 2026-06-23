import { startTransition, useCallback, useEffect, useState } from 'react'
import {
  continueTechnicalOcr,
  deleteProject,
  getProjectDetail,
  getProjectOcrStatus,
  getProjectResults,
  getProjectWorkflowState,
  ingestProjectDocuments,
  listProjects,
  runAnalysis,
  runBusinessOcr,
  runTenderOcr,
  saveProjectWorkflowScope,
} from '../lib/xtjsApi'
import {
  DOCUMENT_LABELS,
  deriveBidderName,
  deriveProjectTitle,
  formatDateTime,
  getParsingProgress,
  getProjectStatus,
  getProjectSummary,
  stripExtension,
} from '../utils/formatters'
import { normalizeProjectResultsPayload } from '../utils/results'
import StatusPill from '../components/StatusPill'
import StatItem from '../components/StatItem'
import EmptyBlock from '../components/EmptyBlock'
import FileUpload from '../components/FileUpload'

const OCR_EXECUTION_MODES = {
  BUSINESS_FIRST: 'business_first',
}

const OCR_MODE_OPTIONS = [
  {
    value: OCR_EXECUTION_MODES.BUSINESS_FIRST,
    label: '分阶段审查',
    description: '先完成招标文件与商务标 OCR，并自动生成不含偏离表的商务审查结果。',
  },
]

const BUSINESS_ANALYSIS_SERVICES = [
  'business_bid_format_review',
]

const PARSING_STATUS_BUSINESS_READY = 2
const PARSING_STATUS_TECHNICAL_READY = 3
const PROJECT_STAGE_POLL_INTERVAL_MS = 5000
const PROJECT_STAGE_POLL_ATTEMPTS = 360
// OCR 进行中时拉取细粒度进度（按文件 + 当前文件页数）的轮询间隔
const OCR_STATUS_POLL_INTERVAL_MS = 2500

// OCR 阶段标签（与后端 ocr-status 的 stage 对齐）
const OCR_STAGE_LABELS = {
  tender: '招标文件',
  business: '商务标',
  technical: '技术标',
}

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
    ocrExecutionMode: OCR_EXECUTION_MODES.BUSINESS_FIRST,
    bidGroups: [createBidGroupDraft()],
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function hasBusinessAnalysisResults(project) {
  const results = project?.results ?? {}
  return BUSINESS_ANALYSIS_SERVICES.every((service) => Boolean(results[service]))
}

function hasTechnicalFileBindings(project) {
  return (project?.relations ?? []).some((relation) => Boolean(relation.technicalFile?.identifierId))
}

function hasTenderStageBindings(project) {
  return (project?.relations ?? []).some((relation) => Boolean(relation.tenderFile?.identifierId))
}

function hasBusinessStageBindings(project) {
  return (project?.relations ?? []).some((relation) => (
    Boolean(relation.tenderFile?.identifierId) &&
    Boolean(relation.businessFile?.identifierId)
  ))
}

function getTechnicalOcrCandidates(project) {
  return (project?.relations ?? [])
    .filter((relation) => Boolean(relation.technicalFile?.identifierId))
    .map((relation, index) => ({
      relationId: relation.id,
      index,
      businessFileName: relation.businessFile?.fileName || '',
      businessBidderName: relation.businessFile?.bidderName || '',
      technicalDocumentId: relation.technicalFile.identifierId,
      technicalFileName: relation.technicalFile.fileName || '',
      technicalBidderName: relation.technicalFile.bidderName || '',
    }))
}

function getExcludedTechnicalIdsFromWorkflowState(workflowState) {
  return (workflowState?.excluded_bidders ?? [])
    .map((item) => item?.technical_bid_document_id || item?.technical_document_identifier_id)
    .filter(Boolean)
}

function buildWorkflowExcludedBidders(candidates, excludedIds) {
  const excludedSet = new Set(excludedIds)
  return candidates
    .filter((candidate) => excludedSet.has(candidate.technicalDocumentId))
    .map((candidate) => ({
      relation_id: candidate.relationId,
      bidder_name: candidate.businessBidderName || candidate.technicalBidderName || candidate.businessFileName || candidate.technicalFileName || '',
      business_file_name: candidate.businessFileName || '',
      technical_bid_document_id: candidate.technicalDocumentId,
      technical_file_name: candidate.technicalFileName || '',
      reason: 'technical_ocr_excluded',
      source_result_key: 'business_bid_format_review',
    }))
}

function getAnalysisRunError(apiResult) {
  const failedItem = (apiResult?.items ?? []).find((item) => item?.status && item.status !== 'success')
  return failedItem?.error || failedItem?.message || ''
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
  const [technicalOcrExcludedIdsByProject, setTechnicalOcrExcludedIdsByProject] = useState({})
  const [ocrStatus, setOcrStatus] = useState(null)

  const loadProjects = useCallback(async () => {
    setIsLoadingProjects(true)
    setNotice(null)

    try {
      const listing = await listProjects({ pageSize: 24 })
      const projectLoads = await Promise.allSettled(
        (listing.items ?? []).map(async (item) => {
          const projectId = getProjectIdentifier(item)
          const [detailResult, resultsResult] = await Promise.allSettled([
            getProjectDetail(projectId),
            getProjectResults(projectId),
          ])
          const project = detailResult.status === 'fulfilled'
            ? normalizeProject(detailResult.value)
            : normalizeProjectFromListItem(item)
          const resultsFailed = resultsResult.status === 'rejected' && Number(resultsResult.reason?.status) !== 404

          return {
            project: {
              ...project,
              results: resultsResult.status === 'fulfilled'
                ? normalizeProjectResultsPayload(resultsResult.value)
                : {},
            },
            detailFailed: detailResult.status === 'rejected',
            resultsFailed,
          }
        }),
      )

      const nextProjects = projectLoads.map((result, index) =>
        result.status === 'fulfilled'
          ? result.value.project
          : normalizeProjectFromListItem(listing.items[index]),
      )

      startTransition(() => {
        setProjects(nextProjects)
        setSelectedProjectId((current) => {
          if (current && nextProjects.some((item) => item.id === current)) {
            return current
          }
          return nextProjects[0]?.id ?? ''
        })
      })

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

  useEffect(() => {
    const projectId = activeProject?.identifierId
    if (!projectId) return undefined

    let cancelled = false
    getProjectWorkflowState(projectId, { forceRefresh: true })
      .then((workflowState) => {
        if (cancelled) return
        const excludedIds = getExcludedTechnicalIdsFromWorkflowState(workflowState)
        setTechnicalOcrExcludedIdsByProject((current) => ({
          ...current,
          [projectId]: excludedIds,
        }))
      })
      .catch(() => null)

    return () => {
      cancelled = true
    }
  }, [activeProject?.identifierId])

  // OCR 细粒度进度：拉取各阶段文件完成情况 + 当前文件逐页进度，OCR 进行中时轮询。
  useEffect(() => {
    const projectId = activeProject?.identifierId
    if (!projectId) {
      setOcrStatus(null)
      return undefined
    }
    const parsingStatus = Number(activeProject?.parsingStatus || 0)
    // OCR 全部完成且当前无进行中操作时不必持续轮询。
    const shouldPoll = Boolean(busyToken) || parsingStatus < PARSING_STATUS_TECHNICAL_READY

    let cancelled = false
    let timer = null
    const tick = async () => {
      try {
        const status = await getProjectOcrStatus(projectId)
        if (!cancelled) setOcrStatus(status)
      } catch {
        if (!cancelled) setOcrStatus(null)
      }
    }
    tick()
    if (shouldPoll) {
      timer = window.setInterval(tick, OCR_STATUS_POLL_INTERVAL_MS)
    }
    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [activeProject?.identifierId, activeProject?.parsingStatus, busyToken])

  const activeProjectHasBusinessResults = hasBusinessAnalysisResults(activeProject)
  const activeProjectParsingStatus = Number(activeProject?.parsingStatus || 0)
  const ocrProgress = ocrStatus?.ocr_progress ?? null
  // active 为"正在进行中的文件"列表(多卡并发时可能多个);兼容旧的单对象形态。
  const ocrActiveList = Array.isArray(ocrProgress?.active)
    ? ocrProgress.active
    : (ocrProgress?.active ? [ocrProgress.active] : [])
  const ocrActiveById = new Map(ocrActiveList.map((item) => [String(item.document_id), item]))
  const ocrStages = (ocrProgress?.stages ?? []).filter((stage) => Number(stage?.total_count || 0) > 0)
  const technicalOcrCandidates = getTechnicalOcrCandidates(activeProject)
  const technicalOcrExcludedIds = technicalOcrExcludedIdsByProject[activeProject?.identifierId] ?? []
  const technicalOcrExcludedSet = new Set(technicalOcrExcludedIds)
  const technicalOcrSelectedCount = technicalOcrCandidates.filter((candidate) => (
    !technicalOcrExcludedSet.has(candidate.technicalDocumentId)
  )).length
  const isBeforeBusinessReady =
    Boolean(activeProject) &&
    activeProjectParsingStatus < PARSING_STATUS_BUSINESS_READY
  const needsTenderOcr =
    Boolean(activeProject) &&
    activeProjectParsingStatus === 0 &&
    hasTenderStageBindings(activeProject)
  const needsBusinessOcr =
    Boolean(activeProject) &&
    activeProjectParsingStatus === 1 &&
    hasBusinessStageBindings(activeProject)
  const needsPreAnalysisOcr = needsTenderOcr || needsBusinessOcr
  const canRunBusinessAnalysis =
    Boolean(activeProject) &&
    activeProjectParsingStatus >= PARSING_STATUS_BUSINESS_READY
  const canContinueTechnicalOcr =
    Boolean(activeProject) &&
    activeProjectParsingStatus === PARSING_STATUS_BUSINESS_READY &&
    activeProjectHasBusinessResults &&
    hasTechnicalFileBindings(activeProject) &&
    technicalOcrSelectedCount > 0

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

  async function toggleTechnicalOcrCandidate(documentId) {
    if (!activeProject?.identifierId || !documentId) return

    const projectId = activeProject.identifierId
    setTechnicalOcrExcludedIdsByProject((current) => {
      const currentSet = new Set(current[projectId] ?? [])
      if (currentSet.has(documentId)) {
        currentSet.delete(documentId)
      } else {
        currentSet.add(documentId)
      }
      return {
        ...current,
        [projectId]: [...currentSet],
      }
    })

    const currentSet = new Set(technicalOcrExcludedIds)
    if (currentSet.has(documentId)) {
      currentSet.delete(documentId)
    } else {
      currentSet.add(documentId)
    }
    const nextExcludedIds = [...currentSet]
    try {
      await saveProjectWorkflowScope(
        projectId,
        buildWorkflowExcludedBidders(technicalOcrCandidates, nextExcludedIds),
      )
    } catch (error) {
      setTechnicalOcrExcludedIdsByProject((current) => ({
        ...current,
        [projectId]: technicalOcrExcludedIds,
      }))
      setNotice({
        type: 'warning',
        message: error.message || '剔除范围保存失败，请稍后重试。',
      })
    }
  }

  function upsertProject(nextProject) {
    if (!nextProject?.id) return

    setProjects((current) => {
      const previousIndex = current.findIndex((item) => item.id === nextProject.id)
      const previous = previousIndex >= 0 ? current[previousIndex] : null
      const hasNextResults = Object.keys(nextProject.results ?? {}).length > 0
      const mergedProject = {
        ...previous,
        ...nextProject,
        results: hasNextResults ? nextProject.results : previous?.results ?? nextProject.results ?? {},
      }

      if (previousIndex < 0) {
        return [mergedProject, ...current]
      }

      const nextProjects = [...current]
      nextProjects[previousIndex] = mergedProject
      return nextProjects
    })
  }

  async function refreshProjectDetailSnapshot(projectId) {
    const project = normalizeProject(await getProjectDetail(projectId, { forceRefresh: true }))
    upsertProject(project)
    return project
  }

  async function refreshProjectSnapshot(projectId) {
    const [detailResult, resultsResult] = await Promise.allSettled([
      getProjectDetail(projectId, { forceRefresh: true }),
      getProjectResults(projectId, { forceRefresh: true }),
    ])

    if (detailResult.status === 'rejected') {
      throw detailResult.reason
    }

    const project = normalizeProject(detailResult.value)
    if (resultsResult.status === 'fulfilled') {
      project.results = normalizeProjectResultsPayload(resultsResult.value)
    }
    upsertProject(project)
    return project
  }

  async function waitForProjectParsingStatus(projectId, targetStatus, targetLabel) {
    for (let attempt = 0; attempt < PROJECT_STAGE_POLL_ATTEMPTS; attempt += 1) {
      const project = await refreshProjectDetailSnapshot(projectId)
      if (Number(project.parsingStatus || 0) >= targetStatus) {
        return project
      }
      await delay(PROJECT_STAGE_POLL_INTERVAL_MS)
    }

    throw new Error(`${targetLabel}等待超时，请稍后刷新项目状态。`)
  }

  async function runBusinessAnalysisForProject(projectId) {
    const apiResult = await runAnalysis({
      projectIdentifier: projectId,
      services: BUSINESS_ANALYSIS_SERVICES,
    })
    const runError = getAnalysisRunError(apiResult)
    if (runError) {
      throw new Error(runError)
    }
    await refreshProjectSnapshot(projectId)
    return apiResult
  }

  async function runPostCreateWorkflow(projectId, parallelism) {
    setNotice({
      type: 'info',
      message: `项目 ${projectId} 创建成功，招标文件与商务标 OCR 已加入队列，正在等待完成...`,
    })
    await runBusinessOcr(projectId, { parallelism })
    await waitForProjectParsingStatus(projectId, PARSING_STATUS_BUSINESS_READY, '招标文件与商务标 OCR')

    setNotice({
      type: 'info',
      message: `项目 ${projectId} 招标文件与商务标 OCR 已完成，正在生成商务标审查结果...`,
    })
    await runBusinessAnalysisForProject(projectId)

    setNotice({
      type: 'success',
      message: `项目 ${projectId} 商务标审查结果已生成，可继续技术标 OCR 后执行偏离表、人员和查重检查。`,
    })
  }

  async function handleCreateProject() {
    if (!canSubmitComposer) return

    setBusyToken('create-project')
    setNotice(null)

    try {
      const businessBidFiles = composer.bidGroups.map((g) => g.businessFile)
      const technicalBidFiles = composer.bidGroups.map((g) => g.technicalFile)
      const parallelism = composer.bidGroupParallelism

      const payload = await ingestProjectDocuments({
        projectName: composer.projectName.trim(),
        bidGroupParallelism: parallelism,
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

      try {
        await runPostCreateWorkflow(projectId, parallelism)
      } catch (workflowError) {
        await refreshProjectSnapshot(projectId).catch(() => null)
        setNotice({
          type: 'warning',
          message: `项目 ${projectId} 创建成功，后续流程未完成：${workflowError.message || '请稍后手动重试。'}`,
        })
      }
    } catch (error) {
      setNotice({
        type: 'error',
        message: error.message || '创建项目失败。',
      })
    } finally {
      setBusyToken('')
    }
  }

  async function handleRunBusinessAnalysis() {
    if (!activeProject || !canRunBusinessAnalysis) return

    setBusyToken('business-analysis')
    setNotice({
      type: 'info',
      message: `正在生成项目 ${activeProject.identifierId} 的商务标审查结果...`,
    })

    try {
      await runBusinessAnalysisForProject(activeProject.identifierId)
      setNotice({
        type: 'success',
        message: `项目 ${activeProject.identifierId} 商务标审查结果已生成。`,
      })
    } catch (error) {
      setNotice({
        type: 'warning',
        message: error.message || '商务标审查结果生成失败，请稍后重试。',
      })
    } finally {
      setBusyToken('')
    }
  }

  async function handleRunTenderOcr() {
    if (!activeProject || !needsTenderOcr) return

    const projectId = activeProject.identifierId
    setBusyToken('tender-ocr')
    setNotice({
      type: 'info',
      message: `项目 ${projectId} 招标文件 OCR 已加入队列，正在等待完成...`,
    })

    try {
      await runTenderOcr(projectId, { parallelism: 1 })
      await waitForProjectParsingStatus(projectId, 1, '招标文件 OCR')
      await refreshProjectSnapshot(projectId)
      setNotice({
        type: 'success',
        message: `项目 ${projectId} 招标文件 OCR 已完成，可继续进行商务标 OCR。`,
      })
    } catch (error) {
      await refreshProjectSnapshot(projectId).catch(() => null)
      setNotice({
        type: 'warning',
        message: error.message || '招标文件 OCR 触发失败，请稍后重试。',
      })
    } finally {
      setBusyToken('')
    }
  }

  async function handleRunBusinessStageOcr() {
    if (!activeProject || !needsBusinessOcr) return

    const projectId = activeProject.identifierId
    setBusyToken('business-ocr')
    setNotice({
      type: 'info',
      message: `项目 ${projectId} 商务标 OCR 已加入队列，正在等待完成...`,
    })

    try {
      await runBusinessOcr(projectId, { parallelism: 1 })
      await waitForProjectParsingStatus(projectId, PARSING_STATUS_BUSINESS_READY, '商务标 OCR')
      await refreshProjectSnapshot(projectId)
      setNotice({
        type: 'success',
        message: `项目 ${projectId} 商务标 OCR 已完成，可进入分析中心。`,
      })
    } catch (error) {
      await refreshProjectSnapshot(projectId).catch(() => null)
      setNotice({
        type: 'warning',
        message: error.message || '商务标 OCR 触发失败，请稍后重试。',
      })
    } finally {
      setBusyToken('')
    }
  }

  async function handleContinueTechnicalOcr() {
    if (!activeProject) return
    if (technicalOcrSelectedCount <= 0) {
      setNotice({
        type: 'warning',
        message: '请至少保留一份技术标用于 OCR。',
      })
      return
    }
    if (!canContinueTechnicalOcr) return

    const projectId = activeProject.identifierId
    const excludedTechnicalDocumentIds = technicalOcrCandidates
      .filter((candidate) => technicalOcrExcludedSet.has(candidate.technicalDocumentId))
      .map((candidate) => candidate.technicalDocumentId)
    setBusyToken('continue-technical-ocr')
    setNotice({
      type: 'info',
      message: excludedTechnicalDocumentIds.length > 0
        ? `项目 ${projectId} 已剔除 ${excludedTechnicalDocumentIds.length} 份技术标，其余技术标 OCR 已加入队列，正在等待完成...`
        : `项目 ${projectId} 技术标 OCR 已加入队列，正在等待完成...`,
    })

    try {
      await saveProjectWorkflowScope(
        projectId,
        buildWorkflowExcludedBidders(technicalOcrCandidates, excludedTechnicalDocumentIds),
      )
      await continueTechnicalOcr(projectId, {
        parallelism: 1,
        excludedTechnicalDocumentIds,
      })
      await waitForProjectParsingStatus(projectId, PARSING_STATUS_TECHNICAL_READY, '技术标 OCR')
      await refreshProjectSnapshot(projectId)
      setNotice({
        type: 'success',
        message: excludedTechnicalDocumentIds.length > 0
          ? `项目 ${projectId} 技术标 OCR 已完成，已剔除不合适技术标 ${excludedTechnicalDocumentIds.length} 份。`
          : `项目 ${projectId} 技术标 OCR 已完成。`,
      })
    } catch (error) {
      await refreshProjectSnapshot(projectId).catch(() => null)
      setNotice({
        type: 'warning',
        message: error.message || '技术标 OCR 触发失败，请稍后重试。',
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

            <div className="field field-wide ocr-field">
              <span>OCR 执行模式</span>
              <div className="ocr-mode-options">
                {OCR_MODE_OPTIONS.map((option) => (
                  <label
                    className={`ocr-mode-option ${composer.ocrExecutionMode === option.value ? 'is-active' : ''}`}
                    key={option.value}
                  >
                    <input
                      type="radio"
                      name="ocrExecutionMode"
                      value={option.value}
                      checked={composer.ocrExecutionMode === option.value}
                      onChange={(event) => updateComposerField('ocrExecutionMode', event.target.value)}
                    />
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </label>
                ))}
              </div>
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
                      label="上传技术标（商务审查后再 OCR）"
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
              {busyToken === 'create-project' ? '执行中...' : '创建并执行 OCR'}
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

                {ocrStages.length > 0 ? (
                  <div className="ocr-progress-panel">
                    <div className="ocr-progress-panel-head">
                      <strong>OCR 进度</strong>
                      {ocrActiveList.length === 1 ? (
                        <span className="ocr-progress-active-hint">
                          正在处理：{ocrActiveList[0].file_name || '当前文件'}
                          {Number(ocrActiveList[0].total_pages) > 0
                            ? `（第 ${ocrActiveList[0].current_page}/${ocrActiveList[0].total_pages} 页 · ${ocrActiveList[0].percent}%）`
                            : `（${ocrActiveList[0].percent}%）`}
                        </span>
                      ) : ocrActiveList.length > 1 ? (
                        <span className="ocr-progress-active-hint">
                          正在并行处理 {ocrActiveList.length} 个文件
                        </span>
                      ) : (
                        <span className="ocr-progress-idle-hint">当前无进行中的文件</span>
                      )}
                    </div>

                    {ocrStages.map((stage) => {
                      const completedDocs = (stage.completed_documents ?? []).map((doc) => ({ doc, state: 'done' }))
                      const pendingDocs = (stage.pending_documents ?? []).map((doc) => ({ doc, state: 'pending' }))
                      const files = [...completedDocs, ...pendingDocs]
                      if (files.length === 0) return null
                      return (
                        <div className="ocr-stage" key={stage.stage}>
                          <div className="ocr-stage-head">
                            <span>{stage.label || OCR_STAGE_LABELS[stage.stage] || stage.stage}</span>
                            <span className="ocr-stage-count">
                              {stage.completed_count}/{stage.total_count} 已完成
                            </span>
                          </div>
                          <ul className="ocr-file-list">
                            {files.map(({ doc, state }) => {
                              const activeRec = ocrActiveById.get(String(doc.identifier_id))
                              const isActive = Boolean(activeRec)
                              const itemState = isActive ? 'active' : state
                              const hasPages = isActive && Number(activeRec.total_pages) > 0
                              return (
                                <li className={`ocr-file ocr-file-${itemState}`} key={doc.identifier_id}>
                                  <span className="ocr-file-icon">
                                    {itemState === 'done' ? '✓' : itemState === 'active' ? '⏳' : '…'}
                                  </span>
                                  <span className="ocr-file-name">{doc.file_name || doc.identifier_id}</span>
                                  {isActive ? (
                                    <span className="ocr-file-pages">
                                      {hasPages
                                        ? `第 ${activeRec.current_page}/${activeRec.total_pages} 页 · ${activeRec.percent}%`
                                        : `${activeRec.percent}%`}
                                    </span>
                                  ) : (
                                    <span className="ocr-file-tag">
                                      {itemState === 'done' ? '已完成' : '待处理'}
                                    </span>
                                  )}
                                  {hasPages ? (
                                    <div className="ocr-file-bar">
                                      <div
                                        className="ocr-file-bar-fill"
                                        style={{ width: `${Math.max(0, Math.min(100, Number(activeRec.percent) || 0))}%` }}
                                      />
                                    </div>
                                  ) : null}
                                </li>
                              )
                            })}
                          </ul>
                        </div>
                      )
                    })}
                  </div>
                ) : null}

                {needsPreAnalysisOcr ? (
                  <div className="project-stage-callout">
                    <strong>{needsTenderOcr ? '需要先完成招标文件 OCR' : '需要先完成商务标 OCR'}</strong>
                    <span>{needsTenderOcr ? '当前项目已绑定文件，但招标文件 OCR 尚未完成。' : '招标文件 OCR 已完成，还需完成商务标 OCR 后才能进入分析中心。'}</span>
                  </div>
                ) : null}

                {activeProjectParsingStatus === PARSING_STATUS_BUSINESS_READY && technicalOcrCandidates.length > 0 ? (
                  <div className="technical-ocr-filter">
                    <div className="technical-ocr-filter-head">
                      <div>
                        <strong>技术标 OCR 范围</strong>
                        <span>
                          已选择 {technicalOcrSelectedCount} / {technicalOcrCandidates.length} 份技术标参与 OCR
                        </span>
                      </div>
                      {technicalOcrExcludedIds.length > 0 ? (
                        <span className="technical-ocr-excluded-count">
                          剔除 {technicalOcrExcludedIds.length} 份
                        </span>
                      ) : null}
                    </div>

                    <div className="technical-ocr-candidate-list">
                      {technicalOcrCandidates.map((candidate) => {
                        const checked = !technicalOcrExcludedSet.has(candidate.technicalDocumentId)
                        const bidderName = candidate.businessBidderName || candidate.technicalBidderName || `标书组 ${candidate.index + 1}`

                        return (
                          <label
                            className={`technical-ocr-candidate ${checked ? 'is-included' : 'is-excluded'}`}
                            key={candidate.technicalDocumentId}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={Boolean(busyToken)}
                              onChange={() => toggleTechnicalOcrCandidate(candidate.technicalDocumentId)}
                            />
                            <div>
                              <strong>{bidderName}</strong>
                              <span>{candidate.technicalFileName}</span>
                              {candidate.businessFileName ? <small>商务标：{candidate.businessFileName}</small> : null}
                            </div>
                            <em>{checked ? '参与 OCR' : '已剔除'}</em>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                ) : null}

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
                        disabled={Boolean(busyToken)}
                      >
                        删除项目
                      </button>
                      {canRunBusinessAnalysis ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={handleRunBusinessAnalysis}
                          disabled={Boolean(busyToken)}
                        >
                          {busyToken === 'business-analysis'
                            ? '生成中...'
                            : activeProjectHasBusinessResults
                              ? '重新生成商务审查'
                              : '生成商务审查'}
                        </button>
                      ) : null}
                      {needsTenderOcr ? (
                        <button
                          type="button"
                          className="primary-button"
                          onClick={handleRunTenderOcr}
                          disabled={Boolean(busyToken)}
                        >
                          {busyToken === 'tender-ocr' ? '招标文件 OCR 中...' : '进行招标文件 OCR'}
                        </button>
                      ) : null}
                      {needsBusinessOcr ? (
                        <button
                          type="button"
                          className="primary-button"
                          onClick={handleRunBusinessStageOcr}
                          disabled={Boolean(busyToken)}
                        >
                          {busyToken === 'business-ocr' ? '商务标 OCR 中...' : '进行商务标 OCR'}
                        </button>
                      ) : null}
                      {activeProjectParsingStatus === PARSING_STATUS_BUSINESS_READY ? (
                        <button
                          type="button"
                          className="primary-button"
                          onClick={handleContinueTechnicalOcr}
                          disabled={!canContinueTechnicalOcr || Boolean(busyToken)}
                        >
                          {busyToken === 'continue-technical-ocr' ? '技术标 OCR 中...' : '继续技术标 OCR'}
                        </button>
                      ) : null}
                      {!isBeforeBusinessReady ? (
                        <a href={`#/analysis?projectId=${activeProject.identifierId}`} className="primary-button">
                          进入分析中心 →
                        </a>
                      ) : null}
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
                          {[relation.tenderFile, relation.businessFile, relation.technicalFile].filter(
                            (file) => Boolean(file?.identifierId),
                          ).map(
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
