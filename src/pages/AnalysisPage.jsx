import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  checkTenderCompliance,
  getProjectDetail,
  getProjectResults,
  listProjects,
  runAnalysis,
} from '../lib/xtjsApi'
import { formatDateTime } from '../utils/formatters'
import { normalizeProjectResultsPayload } from '../utils/results'
import EmptyBlock from '../components/EmptyBlock'
import FileUpload from '../components/FileUpload'
import ProjectDropdown from '../components/ProjectDropdown'

const PARSING_STATUS_BUSINESS_READY = 2
const PARSING_STATUS_TECHNICAL_READY = 3

const FORMAT_REVIEW_CHECKS = [
  { key: 'integrity_check', label: '完整性' },
  { key: 'consistency_check', label: '一致性' },
  { key: 'verification_check', label: '签字盖章日期' },
  { key: 'pricing_check', label: '报价合理性' },
  { key: 'itemized_pricing_check', label: '分项报价表' },
]

const OVERVIEW_CHECK_GROUPS = [
  {
    key: 'format',
    title: '商务标形式审查',
    checks: FORMAT_REVIEW_CHECKS,
  },
  {
    key: 'risk',
    title: '专项审查',
    checks: [
      { key: 'deviation', label: '偏离表' },
      { key: 'personnelReuse', label: '人员复用' },
      { key: 'businessDuplicate', label: '\u5546\u52a1\u6807\u67e5\u91cd' },
      { key: 'technicalDuplicate', label: '技术标查重' },
    ],
  },
]

const ANALYSIS_TYPES = [
  {
    key: 'businessBidFormatReview',
    label: '商务标形式审查',
    icon: '🔍',
    description: '检查商务标格式规范性与完整性',
    services: ['business_bid_format_review'],
    requiredParsingStatus: PARSING_STATUS_BUSINESS_READY,
    stage: 'business',
  },
  {
    key: 'deviationCheck',
    label: '偏离项目审查',
    icon: '📋',
    description: '商务标 OCR 完成即可检查商务标偏离表 ★/△ 响应；技术标就绪后重跑自动并入',
    services: ['deviation_check'],
    requiredParsingStatus: PARSING_STATUS_BUSINESS_READY,
    stage: 'business',
  },
  {
    key: 'personnelReuseCheck',
    label: '人员复用审查',
    icon: '👥',
    description: '抽取商务标和技术标人员，确认名单后检查跨文件复用',
    services: ['personnel_reuse_check'],
    requiredParsingStatus: PARSING_STATUS_TECHNICAL_READY,
    stage: 'technical',
  },
  {
    key: 'businessBidDuplicateCheck',
    label: '\u5546\u52a1\u6807\u67e5\u91cd',
    icon: '\uD83D\uDCC4',
    description: '\u67e5\u5546\u52a1\u5206\u9879\u62a5\u4ef7\u548c\u5546\u52a1/\u6280\u672f\u504f\u79bb\uff1b\u6280\u672f\u504f\u79bb\u8868\u5728\u5546\u52a1\u6807\u672a\u627e\u5230\u65f6\u4f1a\u56de\u9000\u5230\u6280\u672f\u6807\u67e5\u627e',
    services: ['business_bid_duplicate_check'],
    requiredParsingStatus: PARSING_STATUS_BUSINESS_READY,
    stage: 'business',
  },
  {
    key: 'technicalBidDuplicateCheck',
    label: '技术标查重',
    icon: '📐',
    description: '仅对技术标文档之间进行内容查重',
    services: ['technical_bid_duplicate_check'],
    requiredParsingStatus: PARSING_STATUS_TECHNICAL_READY,
    stage: 'technical',
  },
]

const ANALYSIS_STAGE_GROUPS = [
  { key: 'business', title: '商务标审查' },
  { key: 'technical', title: '技术标 OCR 后检查' },
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

function uniqueStrings(values) {
  const seen = new Set()
  const result = []
  arrayify(values).forEach((value) => {
    const text = String(value || '').trim()
    if (!text || seen.has(text)) return
    seen.add(text)
    result.push(text)
  })
  return result
}

function collectionSize(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return 0
}

function normalizeId(value) {
  return String(value || '').trim()
}

function normalizeFileName(value) {
  return String(value || '').trim().toLowerCase()
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

function getRelationId(relation) {
  return relation?.relation_id ?? relation?.id ?? ''
}

function getRelationBusinessId(relation) {
  return relation?.business_bid_identifier_id || relation?.business_bid_document_identifier_id || relation?.business_bid_identifier || ''
}

function getRelationTechnicalId(relation) {
  return relation?.technical_bid_identifier_id || relation?.technical_bid_document_identifier_id || relation?.technical_bid_identifier || ''
}

function getRelationBusinessFileName(relation) {
  return relation?.business_bid_file_name || relation?.business_bid_document_name || relation?.business_file_name || ''
}

function getRelationTechnicalFileName(relation) {
  return relation?.technical_bid_file_name || relation?.technical_bid_document_name || relation?.technical_file_name || ''
}

function getBidderBusinessDocument(bidder) {
  return bidder?.documents?.business || bidder?.documents?.business_bid || bidder?.business_document || {}
}

function getBidderBusinessId(bidder) {
  const document = getBidderBusinessDocument(bidder)
  return document.identifier_id || document.document_identifier_id || bidder?.business_bid_identifier_id || ''
}

function getBidderBusinessFileName(bidder) {
  const document = getBidderBusinessDocument(bidder)
  return document.file_name || document.document_name || bidder?.business_bid_file_name || ''
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

function getIssueBucketCount(issues, key) {
  const value = issues?.[key]
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return normalizeCount(value) ?? 0
}

function sumMetricCounts(metrics, patterns) {
  if (!isPlainObject(metrics)) return 0

  return Object.entries(metrics).reduce((total, [key, value]) => {
    if (!patterns.some((pattern) => pattern.test(key))) return total
    return total + (normalizeCount(value) ?? 0)
  }, 0)
}

function getFormatCheckStatus(check) {
  if (!check) return { state: 'pending', label: '未生成', count: 0 }

  const status = String(
    check.review?.status ||
    check.status ||
    check.validation?.status ||
    check.execution?.status ||
    '',
  ).toLowerCase()
  const executionStatus = String(check.execution?.status || '').toLowerCase()
  const failedCount =
    getIssueBucketCount(check.issues, 'failed') +
    getIssueBucketCount(check.issues, 'missing') +
    sumMetricCounts(check.metrics, [/^failed_/, /^missing_/, /^negative_/, /^late_/])
  const unclearCount =
    getIssueBucketCount(check.issues, 'unclear') +
    sumMetricCounts(check.metrics, [/^unclear_/, /^pending_/])
  const issueCount = failedCount + unclearCount

  if (executionStatus === 'error' || status === 'error') {
    return { state: 'fail', label: '执行失败', count: issueCount || 1 }
  }

  if (['fail', 'failed', 'missing'].includes(status)) {
    return { state: 'fail', label: `${issueCount || 1} 项异常`, count: issueCount || 1 }
  }

  if (['unclear', 'pending'].includes(status) || unclearCount > 0) {
    return { state: 'warning', label: issueCount > 0 ? `${issueCount} 项待复核` : '待复核', count: issueCount }
  }

  if (['pass', 'passed', 'ok', 'correct', 'success'].includes(status)) {
    return { state: 'pass', label: '通过', count: 0 }
  }

  return { state: issueCount > 0 ? 'warning' : 'pending', label: issueCount > 0 ? `${issueCount} 项待复核` : '未生成', count: issueCount }
}

function getRiskStatus(issueCount, hasResult, unavailableLabel = '未生成') {
  if (!hasResult) return { state: 'pending', label: unavailableLabel, count: 0 }
  if (issueCount > 0) return { state: 'fail', label: `${issueCount} 个可疑项`, count: issueCount }
  return { state: 'pass', label: '未发现', count: 0 }
}

function countReviewCheckIssues(check) {
  if (!check) return 0
  const issues = check.issues || {}
  return arrayify(issues.failed).length +
    arrayify(issues.missing).length +
    arrayify(issues.unclear).length +
    sumMetricCounts(check.metrics, [/^failed_/, /^missing_/, /^negative_/, /^late_/, /^unclear_/, /^pending_/])
}

function getDuplicateRiskStatus(result, issueCount, unavailableLabel = '未生成') {
  if (!result) return { state: 'pending', label: unavailableLabel, count: 0 }
  if (issueCount > 0) return getRiskStatus(issueCount, true, unavailableLabel)

  const projectIssueCount = countDuplicateIssues(result)
  if (projectIssueCount > 0) {
    return { state: 'warning', label: `项目有 ${projectIssueCount} 项`, count: projectIssueCount }
  }

  return getRiskStatus(0, true, unavailableLabel)
}

function matchesDocument(item, { identifierId, relationId, fileName }) {
  const targetId = normalizeId(identifierId)
  const targetRelationId = normalizeId(relationId)
  const targetFileName = normalizeFileName(fileName)

  const candidateIds = [
    item?.identifier_id,
    item?.document_identifier_id,
    item?.document_identifier,
    item?.left_document_identifier,
    item?.right_document_identifier,
  ].map(normalizeId).filter(Boolean)

  if (targetId && candidateIds.includes(targetId)) return true

  const candidateRelationIds = [
    item?.relation_id,
    item?.left_relation_id,
    item?.right_relation_id,
  ].map(normalizeId).filter(Boolean)

  if (targetRelationId && candidateRelationIds.includes(targetRelationId)) return true

  const candidateFileNames = [
    item?.file_name,
    item?.document_name,
    item?.left_file_name,
    item?.right_file_name,
  ].map(normalizeFileName).filter(Boolean)

  return Boolean(targetFileName && candidateFileNames.includes(targetFileName))
}

function getDuplicateIssueCountForFile(result, groupKey, documentTarget) {
  const group = result?.groups?.[groupKey]
  if (!group) return 0

  return arrayify(group.items).filter((item) => {
    if (!isDuplicateIssueVisible(item)) return false
    return matchesDocument(item, documentTarget)
  }).length
}

function getPersonnelIssueCountForFile(result, documentTarget) {
  let count = 0

  objectValues(result?.groups).forEach((groupValue) => {
    const check = groupValue?.personnel_reuse_check || {}
    arrayify(check.items).concat(arrayify(check.issues)).forEach((item) => {
      const candidates = [
        item,
        ...arrayify(item.documents),
        ...arrayify(item.occurrences),
        ...arrayify(item.files),
      ]
      if (candidates.some((candidate) => matchesDocument(candidate, documentTarget))) {
        count += 1
      }
    })
  })

  return count
}

function findFormatBidder(result, relation) {
  const relationBusinessId = normalizeId(getRelationBusinessId(relation))
  const relationBusinessFileName = normalizeFileName(getRelationBusinessFileName(relation))
  const bidders = getFormatReviewBidders(result)

  return bidders.find((bidder) => {
    const bidderBusinessId = normalizeId(getBidderBusinessId(bidder))
    const bidderBusinessFileName = normalizeFileName(getBidderBusinessFileName(bidder))
    if (relationBusinessId && bidderBusinessId === relationBusinessId) return true
    return Boolean(relationBusinessFileName && bidderBusinessFileName === relationBusinessFileName)
  }) || null
}

function buildOverviewCards(projectMeta, resultState, parsingStatus) {
  const relations = arrayify(projectMeta?.relations)
  const formatResult = resultState.businessBidFormatReview
  const deviationResult = resultState.deviationCheck
  const businessDuplicateResult = resultState.businessBidDuplicateCheck
  const technicalDuplicateResult = resultState.technicalBidDuplicateCheck
  const personnelResult = resultState.personnelReuseCheck

  return relations.map((relation, index) => {
    const relationId = getRelationId(relation)
    const businessFileName = getRelationBusinessFileName(relation)
    const technicalFileName = getRelationTechnicalFileName(relation)
    const businessTarget = {
      identifierId: getRelationBusinessId(relation),
      relationId,
      fileName: businessFileName,
    }
    const technicalTarget = {
      identifierId: getRelationTechnicalId(relation),
      relationId,
      fileName: technicalFileName,
    }
    const bidder = findFormatBidder(formatResult, relation)
    const formatChecks = Object.fromEntries(
      FORMAT_REVIEW_CHECKS.map((check) => [
        check.key,
        getFormatCheckStatus(bidder?.checks?.[check.key]),
      ]),
    )
    const businessDuplicateCount = getDuplicateIssueCountForFile(
      businessDuplicateResult,
      'business_bid',
      businessTarget,
    )
    const technicalDuplicateCount = getDuplicateIssueCountForFile(
      technicalDuplicateResult,
      'technical_bid',
      technicalTarget,
    )
    const personnelIssueCount = getPersonnelIssueCountForFile(personnelResult, businessTarget) +
      getPersonnelIssueCountForFile(personnelResult, technicalTarget)
    const deviationBidder = findFormatBidder(deviationResult, relation)
    const deviationCheck = deviationBidder?.checks?.deviation_check
    const deviationStatus = deviationResult
      ? getRiskStatus(countReviewCheckIssues(deviationCheck), true)
      : getRiskStatus(
        0,
        false,
        Number(parsingStatus || 0) >= PARSING_STATUS_TECHNICAL_READY ? '未生成' : '技术标未解析',
      )

    return {
      id: relationId || `${businessFileName}-${technicalFileName}-${index}`,
      title: bidder?.bidder_name || businessFileName || `标书组 ${index + 1}`,
      subtitle: businessFileName || '商务标文件',
      technicalFileName,
      formatChecks,
      riskChecks: {
        deviation: deviationStatus,
        businessDuplicate: getDuplicateRiskStatus(businessDuplicateResult, businessDuplicateCount),
        technicalDuplicate: getDuplicateRiskStatus(
          technicalDuplicateResult,
          technicalDuplicateCount,
          Number(parsingStatus || 0) >= PARSING_STATUS_TECHNICAL_READY ? '未生成' : '技术标未解析',
        ),
        personnelReuse: getRiskStatus(personnelIssueCount, Boolean(personnelResult)),
      },
    }
  })
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

  if (
    analysisType.key === 'businessBidFormatReview'
  ) {
    return businessCount
  }

  if (analysisType.key === 'personnelReuseCheck' || analysisType.key === 'deviationCheck') {
    return businessCount + technicalCount
  }

  if (analysisType.key === 'businessBidDuplicateCheck') {
    return businessCount
  }

  if (analysisType.key === 'technicalBidDuplicateCheck') {
    return technicalCount
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
  if (isPersonnelConfirmationPending(result)) return 0
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

function getPersonnelEntryName(entry) {
  return String(
    entry?.name ||
    entry?.person_name ||
    entry?.personnel_name ||
    entry?.display_name ||
    ''
  ).trim()
}

function collectPersonnelNames(result) {
  let names = arrayify(result?.names)
    .concat(arrayify(result?.personnel_extraction?.names))
    .concat(arrayify(result?.config?.confirmed_names))

  objectValues(result?.groups).forEach((groupValue) => {
    const check = groupValue?.personnel_reuse_check || {}
    names = names.concat(arrayify(check.names))
    arrayify(check.personnel_entries).forEach((entry) => {
      names.push(getPersonnelEntryName(entry))
    })
    arrayify(check.documents).forEach((document) => {
      names = names.concat(arrayify(document.names))
      arrayify(document.personnel_entries).forEach((entry) => {
        names.push(getPersonnelEntryName(entry))
      })
    })
  })

  return uniqueStrings(names)
}

function getPersonnelConfirmationStatus(result) {
  return String(
    result?.config?.confirmation_status ||
    result?.personnel_extraction?.confirmation_status ||
    '',
  ).toLowerCase()
}

function isPersonnelConfirmationPending(result) {
  if (!result) return false
  if (result?.config?.confirmation_required) return true
  return getPersonnelConfirmationStatus(result) === 'pending'
}

function isPersonnelConfirmed(result) {
  if (!result) return false
  const status = getPersonnelConfirmationStatus(result)
  if (status === 'confirmed') return true
  if (status === 'pending') return false
  return !result?.config?.confirmation_required
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

const SERVICE_SUMMARIZERS = {
  business_bid_format_review: {
    countDocuments: countFormatReviewDocuments,
    countIssues: countFormatReviewIssues,
  },
  deviation_check: {
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

function getAnalysisStatusIcon(status, suspiciousCount = 0) {
  switch (status) {
    case 'running':
      return '⏳'
    case 'success':
      return Number(suspiciousCount || 0) > 0 ? '⚠️' : '✅'
    case 'error':
      return '❌'
    default:
      return null
  }
}

function getTenderComplianceStatusMeta(status) {
  switch (String(status || '').toLowerCase()) {
    case 'pass':
    case 'passed':
      return { label: '通过', className: 'pass' }
    case 'fail':
    case 'failed':
      return { label: '异常', className: 'fail' }
    case 'unclear':
      return { label: '待复核', className: 'unclear' }
    default:
      return { label: '未检查', className: 'pending' }
  }
}

function getTenderComplianceSummaryLabel(summary) {
  const status = String(summary?.overall_status || '').toLowerCase()
  if (status === 'failed') return '发现异常'
  if (status === 'unclear') return '存在待复核项'
  if (status === 'passed') return '全部通过'
  return '等待检查'
}

function formatTenderComplianceKey(key) {
  const labels = {
    amount_yuan: '金额',
    budget: '项目预算',
    highest_limit: '最高限价',
    bid_security: '投标保证金',
    ratio_percent: '占比',
    percent: '比例',
    raw_value: '原文',
    schedule: '前附表',
    technical: '技术需求',
    contract: '合同',
    total_score: '总分',
    category_scores: '大类分值',
    category_sums: '细项满分合计',
    category_detail_sums: '细项合计',
    scoring_items: '评分项',
    anomalies: '评分异常',
    range_anomalies: '区间异常',
  }
  return labels[key] || key
}

function formatTenderComplianceValue(value) {
  if (value === null || value === undefined || value === '') return '--'
  if (typeof value === 'number') return Number.isInteger(value) ? `${value}` : `${Number(value.toFixed(4))}`
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}...` : value
  if (Array.isArray(value)) {
    if (value.length === 0) return '--'
    const primitive = value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))
    return primitive ? value.map(formatTenderComplianceValue).join('、') : `${value.length} 项`
  }
  if (isPlainObject(value)) {
    if (value.raw_amount || value.amount_yuan) {
      const amount = value.raw_amount || value.amount_yuan
      return value.page ? `${amount}（第 ${value.page} 页）` : `${amount}`
    }
    if (value.raw_value || value.percent !== undefined) {
      return value.raw_value || `${value.percent}%`
    }
    if (Array.isArray(value.percentages) && value.percentages.length > 0) {
      return value.percentages.map((item) => `${item}%`).join('、')
    }
    if (value.canonical) return formatTenderComplianceValue(value.canonical)
    const text = JSON.stringify(value)
    return text.length > 90 ? `${text.slice(0, 90)}...` : text
  }
  return String(value)
}

function getTenderScoreTypeLabel(scoreType) {
  const labels = {
    fixed: '固定分',
    interval: '区间分',
    deduction: '扣分项',
    unknown: '待识别',
  }
  return labels[scoreType] || '待识别'
}

function formatTenderScoreRule(item) {
  if (item?.score_type === 'interval') {
    const ranges = arrayify(item.ranges)
      .map((range) => `${range.start}-${range.end} 分`)
      .join('；')
    if (ranges) return ranges
  }
  if (item?.score_type === 'deduction' && item?.deduction_rule) {
    return item.deduction_rule.text || (
      item.deduction_rule.max_deduction !== null && item.deduction_rule.max_deduction !== undefined
        ? `最多扣 ${item.deduction_rule.max_deduction} 分`
        : '扣分上限待复核'
    )
  }
  return item?.criteria || '--'
}

function formatTenderScorePages(item) {
  const pages = arrayify(item?.evidence?.pages)
  if (pages.length > 0) return pages.map((page) => `第 ${page} 页`).join('、')
  return item?.evidence?.page ? `第 ${item.evidence.page} 页` : '--'
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
  const [tenderComplianceFile, setTenderComplianceFile] = useState(null)
  const [tenderComplianceStatus, setTenderComplianceStatus] = useState('idle')
  const [tenderComplianceResult, setTenderComplianceResult] = useState(null)
  const [tenderComplianceError, setTenderComplianceError] = useState('')
  const selectedProjectIdRef = useRef(selectedProjectId)

  const currentProjectMeta = useMemo(() => {
    const listProject = projects.find((item) => String(getProjectIdentifier(item)) === String(selectedProjectId || '')) || null
    return mergeProjectMeta(listProject, selectedProjectMeta)
  }, [projects, selectedProjectId, selectedProjectMeta])

  const enabledAnalysisTypes = ANALYSIS_TYPES.filter((analysisType) => !isServiceDisabled(analysisType))

  const isRunning = useMemo(() => Object.values(analysisStatus).some((status) => status === 'running'), [analysisStatus])
  const overviewCards = useMemo(() => (
    buildOverviewCards(currentProjectMeta, results, selectedProjectParsingStatus)
  ), [currentProjectMeta, results, selectedProjectParsingStatus])
  const tenderComplianceChecks = useMemo(
    () => arrayify(tenderComplianceResult?.checks),
    [tenderComplianceResult],
  )
  const tenderComplianceSummary = tenderComplianceResult?.summary || null

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
      getProjectDetail(projectId, { forceRefresh: true }),
      getProjectResults(projectId, { forceRefresh: true }),
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
    const personnelConfirmed = isPersonnelConfirmed(results.personnelReuseCheck)
    setCheckedServices((prev) => {
      const next = new Set([...prev].filter((key) => {
        const analysisType = ANALYSIS_TYPES.find((item) => item.key === key)
        return analysisType &&
          canUseAnalysisType(analysisType, selectedProjectParsingStatus) &&
          (!analysisType.requiresPersonnelConfirmation || personnelConfirmed)
      }))

      return next.size === prev.size ? prev : next
    })
  }, [results.personnelReuseCheck, selectedProjectParsingStatus])

  function handleProjectChange(projectId) {
    setSelectedProjectId(projectId)
    setSearchParams(projectId ? { projectId } : {})
    setResults({})
    setAnalysisStatus({})
    setCheckedServices(new Set())
    setSelectedProjectParsingStatus(0)
    setSelectedProjectMeta(null)
  }

  function handleTenderComplianceFileChange(file) {
    if (!file) return
    setTenderComplianceFile(file)
    setTenderComplianceResult(null)
    setTenderComplianceError('')
    setTenderComplianceStatus('idle')
  }

  async function handleRunTenderComplianceCheck() {
    if (!tenderComplianceFile || tenderComplianceStatus === 'running') return
    if (!/\.pdf$/i.test(tenderComplianceFile.name || '')) {
      const message = '招标文件规范检查仅支持 PDF 文件'
      setTenderComplianceStatus('error')
      setTenderComplianceError(message)
      setNotice({ type: 'error', message })
      return
    }

    setTenderComplianceStatus('running')
    setTenderComplianceError('')
    setTenderComplianceResult(null)

    try {
      const result = await checkTenderCompliance(tenderComplianceFile)
      setTenderComplianceResult(result)
      setTenderComplianceStatus('success')
      setNotice({
        type: result?.summary?.failed > 0 ? 'warning' : 'success',
        message: `招标文件规范检查完成：${getTenderComplianceSummaryLabel(result?.summary)}`,
      })
    } catch (error) {
      setTenderComplianceStatus('error')
      setTenderComplianceError(error.message)
      setNotice({ type: 'error', message: `招标文件规范检查失败: ${error.message}` })
    }
  }

  function isServiceDisabled(analysisType) {
    if (!canUseAnalysisType(analysisType, selectedProjectParsingStatus)) return true
    if (analysisType.requiresPersonnelConfirmation && !isPersonnelConfirmed(results.personnelReuseCheck)) {
      return true
    }
    return false
  }

  function getAnalysisDisabledHint(analysisType) {
    if (!canUseAnalysisType(analysisType, selectedProjectParsingStatus)) {
      return getDisabledHint(analysisType, selectedProjectParsingStatus)
    }
    if (analysisType.requiresPersonnelConfirmation && !isPersonnelConfirmed(results.personnelReuseCheck)) {
      return '请先到结果审核确认人员抽取并完成人员复用检查'
    }
    return ''
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

  const tenderCompliancePanelMeta = tenderComplianceStatus === 'running'
    ? { label: '检查中', className: 'running' }
    : tenderComplianceStatus === 'error'
      ? { label: '执行失败', className: 'fail' }
      : getTenderComplianceStatusMeta(tenderComplianceSummary?.overall_status)

  return (
    <>
      {notice ? (
        <div className={`notice notice-${notice.type}`}>
          <p>{notice.message}</p>
        </div>
      ) : null}

      <section className="panel tender-compliance-panel">
        <div className="panel-header tender-compliance-head">
          <div>
            <h2>招标文件规范检查</h2>
            <p>上传单份招标 PDF，检查预算、限价、保证金、付款方式和评标办法是否规范</p>
          </div>
          <span className={`tender-compliance-state tender-compliance-state-${tenderCompliancePanelMeta.className}`}>
            {tenderCompliancePanelMeta.label}
          </span>
        </div>

        <div className="tender-compliance-controls">
          <FileUpload
            accept=".pdf,application/pdf"
            label="拖拽或点击上传招标 PDF"
            fileName={tenderComplianceFile?.name}
            onChange={handleTenderComplianceFileChange}
          />
          <button
            type="button"
            className="primary-button"
            onClick={handleRunTenderComplianceCheck}
            disabled={!tenderComplianceFile || tenderComplianceStatus === 'running'}
          >
            {tenderComplianceStatus === 'running' ? '检查中...' : '开始检查'}
          </button>
        </div>

        {tenderComplianceError ? (
          <div className="tender-compliance-error">{tenderComplianceError}</div>
        ) : null}

        {tenderComplianceSummary ? (
          <div className="tender-compliance-summary">
            <div>
              <span>总体状态</span>
              <strong>{getTenderComplianceSummaryLabel(tenderComplianceSummary)}</strong>
            </div>
            <div>
              <span>通过</span>
              <strong>{tenderComplianceSummary.passed ?? 0}</strong>
            </div>
            <div>
              <span>异常</span>
              <strong>{tenderComplianceSummary.failed ?? 0}</strong>
            </div>
            <div>
              <span>待复核</span>
              <strong>{tenderComplianceSummary.unclear ?? 0}</strong>
            </div>
          </div>
        ) : null}

        {tenderComplianceChecks.length > 0 ? (
          <div className="tender-compliance-check-list">
            {tenderComplianceChecks.map((check) => {
              const statusMeta = getTenderComplianceStatusMeta(check.status)
              const valueEntries = Object.entries(check.values || {}).filter(([key, value]) => (
                key !== 'scoring_items' && value !== null && value !== undefined && value !== ''
              ))
              const contexts = arrayify(check.evidence?.contexts).slice(0, 2)
              const scoringItems = arrayify(check.values?.scoring_items)

              return (
                <article
                  className={`tender-compliance-check tender-compliance-check-${statusMeta.className} ${scoringItems.length > 0 ? 'tender-compliance-check-evaluation' : ''}`}
                  key={check.code}
                >
                  <div className="tender-compliance-check-head">
                    <strong>{check.title}</strong>
                    <span>{statusMeta.label}</span>
                  </div>
                  <p>{check.message}</p>
                  {valueEntries.length > 0 ? (
                    <div className="tender-compliance-values">
                      {valueEntries.slice(0, 6).map(([key, value]) => (
                        <span key={key}>
                          {formatTenderComplianceKey(key)}：{formatTenderComplianceValue(value)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {scoringItems.length > 0 ? (
                    <div className="tender-evaluation-table-wrap">
                      <table className="tender-evaluation-table">
                        <thead>
                          <tr>
                            <th>大类</th>
                            <th>评分项</th>
                            <th>类型</th>
                            <th>单项满分</th>
                            <th>评分/扣分规则</th>
                            <th>结果</th>
                            <th>位置</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scoringItems.map((item, index) => {
                            const itemStatus = getTenderComplianceStatusMeta(item.status)
                            return (
                              <tr key={`${item.category || 'unknown'}-${item.item_name || index}-${index}`}>
                                <td>{item.category_label || '--'}</td>
                                <td>{item.item_name || '--'}</td>
                                <td>{getTenderScoreTypeLabel(item.score_type)}</td>
                                <td>{item.item_max_score ?? '--'}</td>
                                <td className="tender-evaluation-rule">{formatTenderScoreRule(item)}</td>
                                <td>
                                  <span className={`tender-evaluation-status tender-evaluation-status-${itemStatus.className}`}>
                                    {itemStatus.label}
                                  </span>
                                </td>
                                <td>{formatTenderScorePages(item)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {contexts.length > 0 ? (
                    <div className="tender-compliance-evidence">
                      {contexts.map((item, index) => (
                        <small key={`${check.code}-${index}`}>
                          {item.page ? `第 ${item.page} 页：` : ''}
                          {formatTenderComplianceValue(item.text)}
                        </small>
                      ))}
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
        ) : null}
      </section>

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
        function renderCard(analysisType) {
          const status = analysisStatus[analysisType.key] ?? 'idle'
          const result = results[analysisType.key]
          const personnelPending = analysisType.key === 'personnelReuseCheck' && isPersonnelConfirmationPending(result)
          const suspiciousCount = personnelPending ? 0 : (result?.summary?.suspicious ?? 0)
          const personnelNames = analysisType.key === 'personnelReuseCheck'
            ? collectPersonnelNames(result)
            : []
          const disabled = isServiceDisabled(analysisType)
          const disabledHint = getAnalysisDisabledHint(analysisType)

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
                  {!disabled && getAnalysisStatusIcon(status, suspiciousCount) ? (
                    <span
                      className={`analysis-status-icon ${status === 'success' && suspiciousCount > 0 ? 'analysis-status-warning' : ''}`}
                    >
                      {getAnalysisStatusIcon(status, suspiciousCount)}
                    </span>
                  ) : null}
                </div>
              </div>

              <p>{analysisType.description}</p>

              {disabled ? (
                <span className="analysis-card-hint">{disabledHint}</span>
              ) : null}

              {!disabled && status === 'success' && result ? (
                <div className="analysis-card-result">
                  <span>
                    共检查 {result.summary?.document_count ?? '--'} 份文档
                  </span>
                  {personnelPending ? (
                    <span className="analysis-suspicious">待确认 {personnelNames.length} 个人名</span>
                  ) : suspiciousCount > 0 ? (
                    <span className="analysis-suspicious">发现 {suspiciousCount} 个可疑项</span>
                  ) : (
                    <span className="analysis-clean">未发现可疑项</span>
                  )}
                  {personnelNames.length > 0 && !personnelPending ? (
                    <div className="analysis-personnel-names">
                      {personnelNames.map((name) => (
                        <span key={name}>{name}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {!disabled && status === 'success' && selectedProjectId ? (
                <div className="analysis-card-actions">
                  <a
                    href={`#/review?projectId=${selectedProjectId}`}
                    className="ghost-button"
                  >
                    {analysisType.key === 'personnelReuseCheck' && personnelPending ? '确认人员 →' : '查看结果 →'}
                  </a>
                </div>
              ) : null}
            </div>
          )
        }

        return (
          <>
            {ANALYSIS_STAGE_GROUPS.map((group) => {
              const stageTypes = ANALYSIS_TYPES.filter((analysisType) => analysisType.stage === group.key)
              if (stageTypes.length === 0) return null

              return (
                <div className="analysis-group" key={group.key}>
                  <h3 className="analysis-group-title">{group.title}</h3>
                  <div className="analysis-grid">
                    {stageTypes.map(renderCard)}
                  </div>
                </div>
              )
            })}
          </>
        )
      })()}

      {!selectedProjectId ? (
        <section className="panel empty-panel">
          <EmptyBlock title="请先选择一个项目再执行分析" />
        </section>
      ) : null}

      {selectedProjectId ? (
        <section className="panel analysis-overview">
          <div className="panel-header">
            <div>
              <h2>项目审查总览</h2>
              <p>按投标文件汇总形式审查、偏离项目、人员复用和查重情况</p>
            </div>
            <a href={`#/review?projectId=${selectedProjectId}`} className="ghost-button">
              查看审核详情 →
            </a>
          </div>

          {overviewCards.length > 0 ? (
            <div className="overview-file-grid">
              {overviewCards.map((card) => (
                <article className="overview-file-card" key={card.id}>
                  <div className="overview-file-head">
                    <div>
                      <strong>{card.title}</strong>
                      <span>{card.subtitle}</span>
                      {card.technicalFileName ? <small>{card.technicalFileName}</small> : null}
                    </div>
                  </div>

                  {OVERVIEW_CHECK_GROUPS.map((group) => (
                    <div className="overview-check-group" key={group.key}>
                      <h3>{group.title}</h3>
                      <div className="overview-check-list">
                        {group.checks.map((check) => {
                          const status = group.key === 'format'
                            ? card.formatChecks[check.key]
                            : card.riskChecks[check.key]

                          return (
                            <div
                              className={`overview-check-item overview-check-${status?.state || 'pending'}`}
                              key={check.key}
                            >
                              <span>{check.label}</span>
                              <strong>{status?.label || '未生成'}</strong>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </article>
              ))}
            </div>
          ) : (
            <EmptyBlock title="当前项目暂无可展示的投标文件总览" />
          )}
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
