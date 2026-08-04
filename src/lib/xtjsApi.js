const DEFAULT_API_BASE_URL = ''
const API_CACHE_PREFIX = 'xtjs-api-cache:'
const API_CACHE_TTL = {
  projectList: 30 * 1000,
  projectDetail: 2 * 60 * 1000,
  projectResults: 2 * 60 * 1000,
}
const apiMemoryCache = new Map()
const apiInflightCache = new Map()
let apiCacheEpoch = 0

function resolveApiBaseUrl() {
  const rawValue = (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL).trim()

  if (!rawValue) {
    return window.location.origin
  }

  if (/^https?:\/\//i.test(rawValue)) {
    return rawValue.replace(/\/$/, '')
  }

  if (rawValue.startsWith('/')) {
    return `${window.location.origin}${rawValue}`.replace(/\/$/, '')
  }

  return `${window.location.origin}/${rawValue}`.replace(/\/$/, '')
}

export const API_BASE_URL = resolveApiBaseUrl()

// ─── Auth token 管理 ─────────────────────────────────
const AUTH_TOKEN_KEY = 'xtjs-auth-token'
// 当请求遭遇 401 时派发此事件，由 AuthContext 监听并执行登出/跳转登录。
export const AUTH_UNAUTHORIZED_EVENT = 'xtjs:unauthorized'

function canUseLocalStorage() {
  return typeof window !== 'undefined' && window.localStorage
}

export function getToken() {
  if (!canUseLocalStorage()) return null
  try {
    return window.localStorage.getItem(AUTH_TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token) {
  if (!canUseLocalStorage()) return
  try {
    if (token) {
      window.localStorage.setItem(AUTH_TOKEN_KEY, token)
    } else {
      window.localStorage.removeItem(AUTH_TOKEN_KEY)
    }
  } catch {
    // 忽略存储异常（隐私模式等）。
  }
}

export function clearToken() {
  setToken(null)
}

function emitUnauthorized() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT))
  }
}

function buildRequestUrl(path, query = {}) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const fullUrl = API_BASE_URL
    ? `${API_BASE_URL}${normalizedPath}`
    : normalizedPath
  const url = new URL(fullUrl, window.location.origin)

  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return
    }
    url.searchParams.set(key, `${value}`)
  })

  return url
}

function createApiError(message, extra = {}) {
  const error = new Error(message)
  Object.assign(error, extra)
  return error
}

async function parseResponseBody(response) {
  const text = await response.text()

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function unwrapUnifiedPayload(payload, response) {
  if (
    payload &&
    typeof payload === 'object' &&
    'code' in payload &&
    'message' in payload &&
    'data' in payload
  ) {
    const statusCode = Number(payload.code ?? response.status)

    if (statusCode >= 400 || !response.ok) {
      throw createApiError(payload.message || 'XTJS API request failed', {
        status: statusCode,
        payload,
      })
    }

    return payload.data
  }

  if (!response.ok) {
    throw createApiError(
      typeof payload === 'string' ? payload : `XTJS API request failed with status ${response.status}`,
      {
        status: response.status,
        payload,
      },
    )
  }

  return payload
}

export async function request(path, { method = 'GET', query, body, headers } = {}) {
  // 自动携带 Bearer 令牌（已登录时）。
  const token = getToken()
  const finalHeaders = token
    ? { ...(headers || {}), Authorization: `Bearer ${token}` }
    : headers

  const response = await fetch(buildRequestUrl(path, query), {
    method,
    body,
    headers: finalHeaders,
  })

  // 会话失效：清除令牌并通知上层跳转登录，避免无效请求继续。
  if (response.status === 401) {
    clearToken()
    emitUnauthorized()
  }

  const payload = await parseResponseBody(response)
  return unwrapUnifiedPayload(payload, response)
}

function canUseSessionStorage() {
  return typeof window !== 'undefined' && window.sessionStorage
}

function readCachedPayload(cacheKey) {
  const now = Date.now()
  const memoryItem = apiMemoryCache.get(cacheKey)
  if (memoryItem && memoryItem.expiresAt > now) {
    return memoryItem.payload
  }
  if (memoryItem) {
    apiMemoryCache.delete(cacheKey)
  }

  if (!canUseSessionStorage()) return undefined

  try {
    const rawItem = window.sessionStorage.getItem(API_CACHE_PREFIX + cacheKey)
    if (!rawItem) return undefined
    const item = JSON.parse(rawItem)
    if (!item || item.expiresAt <= now) {
      window.sessionStorage.removeItem(API_CACHE_PREFIX + cacheKey)
      return undefined
    }
    apiMemoryCache.set(cacheKey, item)
    return item.payload
  } catch {
    return undefined
  }
}

function writeCachedPayload(cacheKey, payload, ttl) {
  if (!ttl || ttl <= 0) return
  const item = {
    expiresAt: Date.now() + ttl,
    payload,
  }
  apiMemoryCache.set(cacheKey, item)

  if (!canUseSessionStorage()) return
  try {
    window.sessionStorage.setItem(API_CACHE_PREFIX + cacheKey, JSON.stringify(item))
  } catch {
    // Large result payloads can exceed sessionStorage quota; memory cache still helps route changes.
  }
}

function invalidateApiCache(match) {
  apiCacheEpoch += 1
  const matcher = typeof match === 'function'
    ? match
    : (key) => String(key).includes(String(match || ''))

  Array.from(apiMemoryCache.keys()).forEach((key) => {
    if (matcher(key)) apiMemoryCache.delete(key)
  })
  Array.from(apiInflightCache.keys()).forEach((key) => {
    if (matcher(key)) apiInflightCache.delete(key)
  })

  if (!canUseSessionStorage()) return
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const storageKey = window.sessionStorage.key(index)
      if (!storageKey || !storageKey.startsWith(API_CACHE_PREFIX)) continue
      const cacheKey = storageKey.slice(API_CACHE_PREFIX.length)
      if (matcher(cacheKey)) window.sessionStorage.removeItem(storageKey)
    }
  } catch {
    // Ignore cache cleanup failures; the next TTL expiry will clear stale entries.
  }
}

function invalidateProjectCache(identifierId) {
  const encodedIdentifier = encodeURIComponent(identifierId || '')
  invalidateApiCache((key) => (
    key.includes('/api/postgresql/projects?') ||
    (encodedIdentifier && key.includes(`/api/postgresql/projects/${encodedIdentifier}`))
  ))
}

function invalidateProjectResultsCache(identifierId) {
  const encodedIdentifier = encodeURIComponent(identifierId || '')
  if (!encodedIdentifier) return
  invalidateApiCache((key) => key.includes(`/api/postgresql/projects/${encodedIdentifier}/results`))
}

function cachedRequest(path, { query, ttl, forceRefresh = false } = {}) {
  const cacheKey = buildRequestUrl(path, query).href

  if (!forceRefresh) {
    const cached = readCachedPayload(cacheKey)
    if (cached !== undefined) return Promise.resolve(cached)
    const inflight = apiInflightCache.get(cacheKey)
    if (inflight) return inflight
  }

  const requestEpoch = apiCacheEpoch
  const requestPromise = request(path, { query })
    .then((payload) => {
      if (requestEpoch === apiCacheEpoch) {
        writeCachedPayload(cacheKey, payload, ttl)
      }
      return payload
    })
    .finally(() => {
      apiInflightCache.delete(cacheKey)
    })

  apiInflightCache.set(cacheKey, requestPromise)
  return requestPromise
}

// ─── Health ──────────────────────────────────────────

export async function probeBackend() {
  return request('/health')
}

// ─── Projects ────────────────────────────────────────

export async function listProjects({ page = 1, pageSize = 24, keyword, forceRefresh = false } = {}) {
  return cachedRequest('/api/postgresql/projects', {
    query: { page, page_size: pageSize, keyword },
    ttl: API_CACHE_TTL.projectList,
    forceRefresh,
  })
}

export async function getProjectDetail(identifierId, { forceRefresh = false } = {}) {
  return cachedRequest(`/api/postgresql/projects/${encodeURIComponent(identifierId)}`, {
    ttl: API_CACHE_TTL.projectDetail,
    forceRefresh,
  })
}

// 查询项目 OCR 实时状态（各阶段文件完成/待处理 + 当前文件逐页进度）。
// 不走缓存，保证 OCR 进行中拿到最新进度。
export async function getProjectOcrStatus(identifierId) {
  return request(`/api/postgresql/projects/${encodeURIComponent(identifierId)}/ocr-status`)
}

export async function createProject(projectName) {
  const payload = await request('/api/postgresql/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_name: projectName }),
  })
  invalidateProjectCache(payload?.identifier_id || payload?.project?.identifier_id || projectName)
  return payload
}

export async function updateProjectIdentifier(identifierId, newProjectName) {
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(identifierId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_name: newProjectName }),
  })
  invalidateProjectCache(identifierId)
  return payload
}

export async function deleteProject(identifierId) {
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(identifierId)}`, {
    method: 'DELETE',
  })
  invalidateProjectCache(identifierId)
  return payload
}

export async function batchDeleteProjects(identifierIds) {
  const payload = await request('/api/postgresql/projects/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier_ids: identifierIds }),
  })
  invalidateApiCache('/api/postgresql/projects')
  return payload
}

export async function ingestProjectDocuments({
  projectName,
  bidGroupParallelism = 1,
  tenderFile,
  businessBidFiles,
  technicalBidFiles,
}) {
  const formData = new FormData()
  formData.append('project_name', projectName)
  formData.append('tender_file', tenderFile)
  formData.append('bid_group_parallelism', `${bidGroupParallelism}`)

  businessBidFiles.forEach((file) => {
    formData.append('business_bid_files', file)
  })
  technicalBidFiles.forEach((file) => {
    formData.append('technical_bid_files', file)
  })

  const payload = await request('/api/postgresql/projects/batch/ingest-recognize', {
    method: 'POST',
    body: formData,
  })
  invalidateProjectCache(payload?.project?.identifier_id || projectName)
  return payload
}

// 文件夹上传：一个项目文件夹（招标 PDF + 各公司商务/技术子文件夹）一次性建项目并自动绑定。
// files 为浏览器选中的全部 File，relativePaths 为对应的 webkitRelativePath 数组（顺序一致）。
export async function uploadProjectFolder({ files, relativePaths }) {
  const formData = new FormData()
  files.forEach((file) => {
    formData.append('files', file)
  })
  formData.append('paths', JSON.stringify(relativePaths))

  const payload = await request('/api/postgresql/projects/upload-folder', {
    method: 'POST',
    body: formData,
  })
  invalidateApiCache('/api/postgresql/projects')
  return payload
}

// 作者查重预警：OCR 前检测不同公司投标 PDF 是否同一作者/创建人。
export async function getProjectAuthorCheck(projectIdentifier) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/author-check`)
}

// ─── Project Results ─────────────────────────────────

export async function getProjectResults(projectName, { forceRefresh = false } = {}) {
  const path = `/api/postgresql/projects/${encodeURIComponent(projectName)}/results`
  const query = { view: 'display', include_raw_results: 'false', include_result_record: 'false' }
  if (forceRefresh) {
    invalidateProjectResultsCache(projectName)
    return request(path, {
      query: Object.assign({}, query, { force_refresh: 'true' }),
    })
  }
  return cachedRequest(`/api/postgresql/projects/${encodeURIComponent(projectName)}/results`, {
    query,
    ttl: API_CACHE_TTL.projectResults,
  })
}

export async function getProjectSingleResult(projectName, resultKey) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/results/${encodeURIComponent(resultKey)}`)
}

export async function getProjectVisualizationData(projectName) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/visualization-data`)
}

export async function getProjectWorkflowState(projectIdentifier, { forceRefresh = false } = {}) {
  return cachedRequest(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/workflow-state`, {
    ttl: API_CACHE_TTL.projectDetail,
    forceRefresh,
  })
}

export async function saveProjectWorkflowScope(projectIdentifier, excludedBidders = []) {
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/workflow-scope`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ excluded_bidders: excludedBidders }),
  })
  invalidateProjectCache(projectIdentifier)
  return payload
}

export async function saveProjectManualReviewResultInputs(projectIdentifier, resultKey, inputs = {}) {
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/manual-review-results/${encodeURIComponent(resultKey)}/inputs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs }),
  })
  invalidateProjectCache(projectIdentifier)
  return payload
}

export async function rerunProjectManualReview(projectIdentifier, services = []) {
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/manual-review-rerun`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ services }),
  })
  invalidateProjectCache(projectIdentifier)
  return payload
}

// ─── OCR Execution ───────────────────────────────────

export async function runTenderOcr(projectName, { parallelism = 1 } = {}) {
  const formBody = new URLSearchParams()
  formBody.append('parallelism', `${parallelism}`)

  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/run-tender-ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  })
  invalidateProjectCache(projectName)
  return payload
}

export async function runBusinessOcr(projectName, { parallelism = 1 } = {}) {
  const formBody = new URLSearchParams()
  formBody.append('parallelism', `${parallelism}`)

  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/run-business-ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  })
  invalidateProjectCache(projectName)
  return payload
}

export async function continueTechnicalOcr(projectName, { parallelism = 1, excludedTechnicalDocumentIds = [] } = {}) {
  const formBody = new URLSearchParams()
  formBody.append('parallelism', `${parallelism}`)
  if (excludedTechnicalDocumentIds.length > 0) {
    formBody.append('excluded_technical_document_identifiers_json', JSON.stringify(excludedTechnicalDocumentIds))
  }

  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/continue-technical-ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  })
  invalidateProjectCache(projectName)
  return payload
}

export async function runFullOcr(projectName, { parallelism = 1 } = {}) {
  const formBody = new URLSearchParams()
  formBody.append('parallelism', `${parallelism}`)

  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/run-full-ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  })
  invalidateProjectCache(projectName)
  return payload
}

// ─── Analysis Execution ──────────────────────────────

export async function runAnalysis({
  projectIdentifier,
  services,
  maxEvidenceSections = 5,
  maxPairsPerType = 0,
}) {
  const requestPayload = {
    project_identifier: projectIdentifier,
    services,
    max_evidence_sections: maxEvidenceSections,
    max_pairs_per_type: maxPairsPerType,
  }

  const payload = await request('/api/analysis/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestPayload),
  })
  invalidateProjectCache(projectIdentifier)
  return payload
}

export async function checkTenderCompliance(file) {
  const formData = new FormData()
  formData.append('file', file)
  return request('/api/analysis/tender-compliance-check', {
    method: 'POST',
    body: formData,
  })
}

export async function updatePersonnelReuseDraft(projectIdentifier, documents) {
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/personnel-reuse-draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documents }),
  })
  invalidateProjectCache(projectIdentifier)
  return payload
}

export async function confirmPersonnelReuseDraft(projectIdentifier, documents) {
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/personnel-reuse-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documents }),
  })
  invalidateProjectCache(projectIdentifier)
  return payload
}

// ─── Relations ───────────────────────────────────────

export async function getBusinessBidFormatReviewEditable(projectIdentifier) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/business-bid-format-review/editable`)
}

export async function saveBusinessBidFormatReviewManualInputs(projectIdentifier, items) {
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/business-bid-format-review/manual-inputs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  })
  invalidateProjectCache(projectIdentifier)
  return payload
}

export async function rerunBusinessBidFormatReviewWithManualInputs(projectIdentifier, items) {
  await saveBusinessBidFormatReviewManualInputs(projectIdentifier, items)
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/business-bid-format-review/manual-rerun`, {
    method: 'POST',
  })
  invalidateProjectResultsCache(projectIdentifier)
  invalidateProjectCache(projectIdentifier)
  return payload
}

export async function listRelations({ page = 1, pageSize = 50, projectIdentifier } = {}) {
  return request('/api/postgresql/relations', {
    query: { page, page_size: pageSize, project_identifier: projectIdentifier },
  })
}

export async function getRelationDetail(relationId) {
  return request(`/api/postgresql/relations/${relationId}`)
}

export async function bindDocuments(projectName, {
  tenderDocumentIdentifier,
  businessBidDocumentIdentifier,
  technicalBidDocumentIdentifier,
}) {
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/bind-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tender_document_identifier: tenderDocumentIdentifier,
      business_bid_document_identifier: businessBidDocumentIdentifier,
      technical_bid_document_identifier: technicalBidDocumentIdentifier,
    }),
  })
  invalidateProjectCache(projectName)
  return payload
}

export async function updateRelation(relationId, body) {
  const payload = await request(`/api/postgresql/relations/${relationId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  invalidateApiCache('/api/postgresql/projects')
  return payload
}

export async function deleteRelation(relationId) {
  const payload = await request(`/api/postgresql/relations/${relationId}`, {
    method: 'DELETE',
  })
  invalidateApiCache('/api/postgresql/projects')
  return payload
}

export async function batchDeleteRelations(relationIds) {
  const payload = await request('/api/postgresql/relations/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relation_ids: relationIds }),
  })
  invalidateApiCache('/api/postgresql/projects')
  return payload
}

// ─── Documents ───────────────────────────────────────

export async function listDocuments({ page = 1, pageSize = 50, documentType, extracted } = {}) {
  return request('/api/postgresql/documents', {
    query: { page, page_size: pageSize, document_type: documentType, extracted },
  })
}

export async function getDocumentDetail(identifierId) {
  return request(`/api/postgresql/documents/${encodeURIComponent(identifierId)}`)
}

export async function uploadDocument({ file, documentType, identifierId, documentName }) {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('document_type', documentType)
  if (identifierId) formData.append('identifier_id', identifierId)
  if (documentName) formData.append('document_name', documentName)

  return request('/api/postgresql/documents', {
    method: 'POST',
    body: formData,
  })
}

export async function updateDocument(identifierId, body) {
  return request(`/api/postgresql/documents/${encodeURIComponent(identifierId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteDocument(identifierId) {
  return request(`/api/postgresql/documents/${encodeURIComponent(identifierId)}`, {
    method: 'DELETE',
  })
}

export async function batchDeleteDocuments(identifierIds) {
  return request('/api/postgresql/documents/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier_ids: identifierIds }),
  })
}

export function getDocumentSourceUrl(fileNameOrId, page) {
  var url = `${API_BASE_URL}/api/postgresql/documents/${encodeURIComponent(fileNameOrId)}/source`
  if (page) {
    url += `?page=${encodeURIComponent(page)}`
  }
  return url
}

export async function getDocumentPreview(fileNameOrId, page, { highlight, highlightBbox, highlightRects, highlightCoordinateSpace } = {}) {
  const url = `${API_BASE_URL}/api/postgresql/documents/${encodeURIComponent(fileNameOrId)}/preview/pages/${page}`
  const body = {}
  if (Array.isArray(highlight)) {
    const phrases = highlight.filter(Boolean)
    if (phrases.length > 0) body.highlight = phrases
  } else if (highlight) {
    body.highlight = [highlight]
  }
  if (highlightBbox) body.highlight_bbox = highlightBbox
  if (highlightRects) body.highlight_rects = highlightRects
  if (highlightCoordinateSpace) body.highlight_coordinate_space = highlightCoordinateSpace

  // 该接口用裸 fetch（返回结构特殊），需手动带上 Bearer 令牌，否则会被登录守卫拦成 401。
  const token = getToken()
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers,
    body: JSON.stringify(body),
  })

  if (response.status === 401) {
    clearToken()
    emitUnauthorized()
  }
  if (!response.ok) {
    throw createApiError(`Preview failed with status ${response.status}`, { status: response.status })
  }
  return response.json()
}

// ─── Results CRUD ────────────────────────────────────

export async function listResults({ page = 1, pageSize = 50, keyword } = {}) {
  return request('/api/postgresql/results', {
    query: { page, page_size: pageSize, keyword },
  })
}

export async function createOrOverwriteResult(projectIdentifierId, result) {
  const payload = await request('/api/postgresql/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_identifier_id: projectIdentifierId, result }),
  })
  invalidateProjectCache(projectIdentifierId)
  return payload
}

export async function getSingleResult(projectIdentifierId) {
  return request(`/api/postgresql/results/${encodeURIComponent(projectIdentifierId)}`)
}

export async function updateResult(projectIdentifierId, result) {
  const payload = await request(`/api/postgresql/results/${encodeURIComponent(projectIdentifierId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result }),
  })
  invalidateProjectCache(projectIdentifierId)
  return payload
}

export async function exportProjectResultReport(projectIdentifierId, result) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifierId)}/export-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result }),
  })
}

export async function deleteResult(projectIdentifierId) {
  const payload = await request(`/api/postgresql/results/${encodeURIComponent(projectIdentifierId)}`, {
    method: 'DELETE',
  })
  invalidateProjectCache(projectIdentifierId)
  return payload
}

// ─── Export Report ──────────────────────────────────

