const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

export function formatDateTime(value) {
  if (!value) {
    return '--'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return dateFormatter.format(date).replace(/\//g, '-')
}

export function stripExtension(fileName) {
  return String(fileName || '').replace(/\.[^.]+$/, '')
}

export function bidderDisplayName(identity) {
  return identity?.status === 'resolved' && identity?.name ? identity.name : '单位名称未识别'
}

export function deriveProjectTitle(identifierId, relations) {
  const tenderFileName = relations?.[0]?.tenderFile?.fileName
  return tenderFileName ? stripExtension(tenderFileName) : identifierId
}

export const DOCUMENT_LABELS = {
  tender: '招标文件',
  business_bid: '商务标',
  technical_bid: '技术标',
}


export function getParsingProgress(parsingStatus) {
  switch (parsingStatus) {
    case 1:
      return { percent: 33, label: '招标文件已解析' }
    case 2:
      return { percent: 66, label: '商务标已解析' }
    case 3:
      return { percent: 100, label: '解析完成' }
    default:
      return { percent: 0, label: '未开始' }
  }
}

export function getProjectStatus(project) {
  if (project.uploadComplete === false || project.upload_complete === false) {
    return { label: '上传不完整', className: 'status-risk' }
  }
  if (project.resultsStale || project.results_stale) return { label: '需重新检查', className: 'status-ready' }
  const hasRelations = (project.relationCount ?? project.relations.length) > 0
  const results = project.results ?? {}
  const resultKeys = project.resultsLoaded === false
    ? (project.availableResultKeys ?? [])
    : Object.keys(results).filter((k) => results[k])
  const parsingStatus = project.parsingStatus ?? 0
  const summary = project.resultsLoaded === false && project.resultSummary?.version === 1
    ? project.resultSummary : null
  const resultCount = summary ? summary.result_count : resultKeys.length

  if (!hasRelations) {
    return { label: '待绑定', className: 'status-pending' }
  }

  // 解析中（未完成）：显示"解析中"
  if (parsingStatus === 1 || parsingStatus === 2) {
    return { label: '解析中', className: 'status-running' }
  }

  // 解析完成但无分析结果：显示"待分析"
  if (parsingStatus === 3 && resultCount === 0) {
    return { label: '待分析', className: 'status-ready' }
  }

  if (project.resultsLoaded === false && !summary && resultCount > 0) {
    return { label: '状态待更新', className: 'status-ready' }
  }

  const hasSuspicious = summary ? summary.has_suspicious : resultKeys.some((key) => {
    const r = results[key]
    return Number(r?.summary?.suspicious) > 0
  })

  if (hasSuspicious) {
    return { label: '需复核', className: 'status-risk' }
  }

  if (resultCount >= 2) {
    return { label: '已完成', className: 'status-success' }
  }

  if (resultCount > 0) {
    return { label: '处理中', className: 'status-running' }
  }

  return { label: '解析中', className: 'status-ready' }
}

export function getProjectSummary(project) {
  const status = getProjectStatus(project)
  if (status.label === '需重新检查') return '材料已变更，旧结果已过期'
  if (status.label === '状态待更新') return '进入分析中心查看审查结果'

  switch (status.className) {
    case 'status-pending':
      return '尚未形成完整文档关系'
    case 'status-risk':
      return '已发现可疑项，建议人工复核'
    case 'status-success':
      return '多种分析均已完成'
    case 'status-running':
      return '已有部分审查结果'
    default:
      return '可以发起分析审查'
  }
}
