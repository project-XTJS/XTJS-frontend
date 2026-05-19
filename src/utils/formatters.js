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

export function deriveBidderName(fileName) {
  return stripExtension(fileName)
    .replace(/(商务标|技术标|投标文件|扫描件|商务|技术)/g, '')
    .replace(/[()（）_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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

export const DOCUMENT_SCOPE_OPTIONS = [
  { value: 'all', label: '全部标书' },
  { value: 'business_bid', label: '仅商务标' },
  { value: 'technical_bid', label: '仅技术标' },
]

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
  const hasRelations = project.relations.length > 0
  const results = project.results ?? {}
  const resultKeys = Object.keys(results).filter((k) => results[k])
  const parsingStatus = project.parsingStatus ?? 0

  if (!hasRelations) {
    return { label: '待绑定', className: 'status-pending' }
  }

  // 解析中（未完成）：显示"解析中"
  if (parsingStatus === 1 || parsingStatus === 2) {
    return { label: '解析中', className: 'status-running' }
  }

  const hasSuspicious = resultKeys.some((key) => {
    const r = results[key]
    return r?.summary?.suspicious || (r?.summary?.suspicious_pair_count ?? 0) > 0
  })

  if (hasSuspicious) {
    return { label: '需复核', className: 'status-risk' }
  }

  if (resultKeys.length >= 2) {
    return { label: '已完成', className: 'status-success' }
  }

  if (resultKeys.length > 0) {
    return { label: '处理中', className: 'status-running' }
  }

  return { label: '解析中', className: 'status-ready' }
}

export function getProjectSummary(project) {
  const status = getProjectStatus(project)

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
