const DEFAULT_API_BASE_URL = ''
const API_CACHE_PREFIX = 'xtjs-api-cache:'
const API_CACHE_TTL = {
  projectList: 30 * 1000,
  projectDetail: 2 * 60 * 1000,
  projectResults: 2 * 60 * 1000,
}
const API_MEMORY_CACHE_BUDGET_BYTES = 16 * 1024 * 1024
const API_SESSION_CACHE_MAX_BYTES = 256 * 1024
const apiMemoryCache = new Map()
const apiInflightCache = new Map()
let apiCacheEpoch = 0
let apiMemoryCacheBytes = 0

function jsonByteLength(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function deleteMemoryCacheItem(cacheKey) {
  const item = apiMemoryCache.get(cacheKey)
  if (item) apiMemoryCacheBytes = Math.max(0, apiMemoryCacheBytes - Number(item.sizeBytes || 0))
  apiMemoryCache.delete(cacheKey)
}

function writeMemoryCacheItem(cacheKey, item) {
  deleteMemoryCacheItem(cacheKey)
  if (item.sizeBytes > API_MEMORY_CACHE_BUDGET_BYTES) return
  apiMemoryCache.set(cacheKey, item)
  apiMemoryCacheBytes += item.sizeBytes
  while (apiMemoryCacheBytes > API_MEMORY_CACHE_BUDGET_BYTES && apiMemoryCache.size > 0) {
    deleteMemoryCacheItem(apiMemoryCache.keys().next().value)
  }
}

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
  invalidateApiCache(() => true)
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

const projectInputVersions = new Map()
const projectResultVersions = new Map()
const uploadAttempts = new Map()

export async function request(path, { method = 'GET', query, body, headers, timeoutMs = 0, signal } = {}) {
  // 自动携带 Bearer 令牌（已登录时）。
  const token = getToken()
  const finalHeaders = token
    ? { ...(headers || {}), Authorization: `Bearer ${token}` }
    : { ...(headers || {}) }

  const projectPath = path.match(/\/projects\/([^/]+)/)
  const projectId = projectPath ? decodeURIComponent(projectPath[1]) : null
  if (projectId && method !== 'GET' && /\/(manual-review|business-bid-format-review|personnel|export-report)/.test(path) && projectInputVersions.has(projectId)) {
    finalHeaders['X-XTJS-Input-Revision'] = String(projectInputVersions.get(projectId))
  }
  if (projectId && method !== 'GET' && /\/(manual-review|business-bid-format-review|personnel|review\/exports)/.test(path) && projectResultVersions.has(projectId)) {
    finalHeaders['X-XTJS-Result-Version'] = String(projectResultVersions.get(projectId))
  }
  const controller = timeoutMs > 0 ? new AbortController() : null
  const abortFromCaller = function () { controller?.abort() }
  if (signal && controller) signal.addEventListener('abort', abortFromCaller, { once: true })
  const requestSignal = controller ? controller.signal : signal
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const response = await fetch(buildRequestUrl(path, query), {
      method,
      body,
      headers: finalHeaders,
      ...(requestSignal ? { signal: requestSignal } : {}),
    })

    // 会话失效：清除令牌并通知上层跳转登录，避免无效请求继续。
    if (response.status === 401) {
      clearToken()
      emitUnauthorized()
    }

    const payload = await parseResponseBody(response)
    const data = unwrapUnifiedPayload(payload, response)
    if (projectId) {
      const inputRevision = Number.isInteger(data?.input_revision)
        ? data.input_revision
        : data?.project?.input_revision
      if (Number.isInteger(inputRevision)) projectInputVersions.set(projectId, inputRevision)
      const resultVersion = data?.result_version || data?.result_record?.result_version || data?.result_record_meta?.result_version || data?._result_version
      if (resultVersion) projectResultVersions.set(projectId, resultVersion)
    }
    return data
  } catch (error) {
    if (signal?.aborted) throw createApiError('请求已取消', { status: 499 })
    if (controller?.signal.aborted) throw createApiError('加载超时，请稍后重试。', { status: 408 })
    throw error
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (signal && controller) signal.removeEventListener('abort', abortFromCaller)
  }
}

function canUseSessionStorage() {
  if (typeof window === 'undefined') return false
  try {
    return Boolean(window.sessionStorage)
  } catch {
    return false
  }
}

function purgeLegacyOversizedSessionCache() {
  if (!canUseSessionStorage()) return
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const storageKey = window.sessionStorage.key(index)
      if (!storageKey || !storageKey.startsWith(API_CACHE_PREFIX)) continue
      const rawItem = window.sessionStorage.getItem(storageKey)
      if (rawItem && new TextEncoder().encode(rawItem).byteLength > API_SESSION_CACHE_MAX_BYTES) {
        window.sessionStorage.removeItem(storageKey)
      }
    }
  } catch {
    // Storage may be unavailable in privacy mode; in-memory limits still apply.
  }
}

purgeLegacyOversizedSessionCache()

function readCachedPayload(cacheKey) {
  const now = Date.now()
  const memoryItem = apiMemoryCache.get(cacheKey)
  if (memoryItem && memoryItem.expiresAt > now) {
    apiMemoryCache.delete(cacheKey)
    apiMemoryCache.set(cacheKey, memoryItem)
    return memoryItem.payload
  }
  if (memoryItem) {
    deleteMemoryCacheItem(cacheKey)
  }

  if (!canUseSessionStorage()) return undefined

  try {
    const rawItem = window.sessionStorage.getItem(API_CACHE_PREFIX + cacheKey)
    if (!rawItem) return undefined
    if (new TextEncoder().encode(rawItem).byteLength > API_SESSION_CACHE_MAX_BYTES) {
      window.sessionStorage.removeItem(API_CACHE_PREFIX + cacheKey)
      return undefined
    }
    const item = JSON.parse(rawItem)
    if (!item || item.expiresAt <= now) {
      window.sessionStorage.removeItem(API_CACHE_PREFIX + cacheKey)
      return undefined
    }
    item.sizeBytes = Number(item.sizeBytes || jsonByteLength(item.payload))
    if (item.sizeBytes > API_SESSION_CACHE_MAX_BYTES) {
      window.sessionStorage.removeItem(API_CACHE_PREFIX + cacheKey)
      return undefined
    }
    writeMemoryCacheItem(cacheKey, item)
    return item.payload
  } catch {
    return undefined
  }
}

function writeCachedPayload(cacheKey, payload, ttl, persistSession) {
  if (!ttl || ttl <= 0) return
  const sizeBytes = jsonByteLength(payload)
  const item = {
    expiresAt: Date.now() + ttl,
    payload,
    sizeBytes,
  }
  writeMemoryCacheItem(cacheKey, item)

  if (!persistSession || sizeBytes > API_SESSION_CACHE_MAX_BYTES || !canUseSessionStorage()) return
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
    if (matcher(key)) deleteMemoryCacheItem(key)
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

let cachedSessionToken = null

function cachedRequest(path, {
  query,
  ttl,
  forceRefresh = false,
  timeoutMs,
  cacheVersion = '',
  persistSession = false,
  signal,
} = {}) {
  // localStorage can change in another tab without calling setToken here.
  const requestToken = getToken()
  if (requestToken !== cachedSessionToken) {
    invalidateApiCache(() => true)
    cachedSessionToken = requestToken
  }
  const cacheKey = buildRequestUrl(path, query).href + (cacheVersion ? `#${cacheVersion}` : '')

  if (!forceRefresh) {
    const cached = readCachedPayload(cacheKey)
    if (cached !== undefined) return Promise.resolve(cached)
    const inflight = signal ? null : apiInflightCache.get(cacheKey)
    if (inflight) return inflight
  }

  const requestEpoch = apiCacheEpoch
  const requestPromise = request(path, { query, timeoutMs, signal })
    .then((payload) => {
      if (requestToken !== getToken()) throw new Error('登录账号已变更，请重新加载')
      if (requestEpoch === apiCacheEpoch) {
        writeCachedPayload(cacheKey, payload, ttl, persistSession)
      }
      return payload
    })
    .finally(() => {
      if (!signal) apiInflightCache.delete(cacheKey)
    })

  if (!signal) apiInflightCache.set(cacheKey, requestPromise)
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
    cacheVersion: 'result-summary-v1',
    timeoutMs: 20000,
    forceRefresh,
  })
}

export async function getProjectDetail(identifierId, { forceRefresh = false } = {}) {
  return cachedRequest(`/api/postgresql/projects/${encodeURIComponent(identifierId)}`, {
    ttl: API_CACHE_TTL.projectDetail,
    timeoutMs: 20000,
    forceRefresh,
  })
}

// 查询项目 OCR 实时状态（各阶段文件完成/待处理 + 当前文件逐页进度）。
// 不走缓存，保证 OCR 进行中拿到最新进度。
export async function getProjectOcrStatus(identifierId) {
  return request(`/api/postgresql/projects/${encodeURIComponent(identifierId)}/ocr-status`, { timeoutMs: 20000 })
}


export async function uploadMissingProjectFile(projectIdentifier, { slot = '', file } = {}) {
  const body = new FormData()
  body.append('slot', slot)
  const attemptKey = `${projectIdentifier}:${slot}`
  if (!uploadAttempts.has(attemptKey)) uploadAttempts.set(attemptKey, (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`))
  body.append('attempt_id', uploadAttempts.get(attemptKey))
  if (file) body.append('file', file)
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/upload-missing`, {
    method: 'POST', body,
  })
  invalidateProjectCache(projectIdentifier)
  return payload
}


export async function deleteProject(identifierId) {
  const payload = await request(`/api/postgresql/projects/${encodeURIComponent(identifierId)}`, {
    method: 'DELETE',
  })
  invalidateProjectCache(identifierId)
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

export async function getProjectReviewSummary(projectIdentifier, { forceRefresh = false, signal } = {}) {
  return cachedRequest(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/review/summary`, {
    ttl: API_CACHE_TTL.projectResults,
    timeoutMs: 20000,
    forceRefresh,
    cacheVersion: 'review-summary-v1',
    persistSession: true,
    signal,
  })
}

export async function getProjectReviewComponent(projectIdentifier, resultKey, resultVersion, { signal } = {}) {
  return cachedRequest(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/review/results/${encodeURIComponent(resultKey)}`, {
    query: { result_version: resultVersion },
    ttl: API_CACHE_TTL.projectResults,
    timeoutMs: 60000,
    cacheVersion: resultVersion,
    signal,
  })
}

export async function listProjectReviewIssues(projectIdentifier, {
  resultVersion,
  resultKey,
  riskLevel,
  status,
  checkCode,
  fileName,
  limit = 20,
  offset = 0,
  signal,
} = {}) {
  return cachedRequest(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/review/issues`, {
    query: {
      result_version: resultVersion,
      result_key: resultKey,
      risk_level: riskLevel,
      status,
      check_code: checkCode,
      file_name: fileName,
      limit,
      offset,
    },
    ttl: API_CACHE_TTL.projectResults,
    timeoutMs: 30000,
    cacheVersion: resultVersion,
    signal,
  })
}

export async function getProjectReviewIssue(projectIdentifier, issueId, resultVersion, { signal } = {}) {
  return cachedRequest(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/review/issues/${encodeURIComponent(issueId)}`, {
    query: { result_version: resultVersion },
    ttl: API_CACHE_TTL.projectResults,
    timeoutMs: 30000,
    cacheVersion: resultVersion,
    signal,
  })
}

export async function getProjectReviewIssueEvidence(projectIdentifier, issueId, resultVersion, {
  limit = 20,
  offset = 0,
  signal,
} = {}) {
  return cachedRequest(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/review/issues/${encodeURIComponent(issueId)}/evidence`, {
    query: { result_version: resultVersion, limit, offset },
    ttl: API_CACHE_TTL.projectResults,
    timeoutMs: 60000,
    cacheVersion: resultVersion,
    signal,
  })
}

export async function getProjectReviewIssueIds(projectIdentifier, filters = {}) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/review/issue-ids`, {
    query: {
      result_version: filters.resultVersion,
      result_key: filters.resultKey,
      risk_level: filters.riskLevel,
      status: filters.status,
      check_code: filters.checkCode,
      file_name: filters.fileName,
    },
    timeoutMs: 30000,
    signal: filters.signal,
  })
}

export async function exportProjectReview(projectIdentifier, resultVersion, format, reviewStatuses = {}) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/review/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result_version: resultVersion, format, review_statuses: reviewStatuses }),
    timeoutMs: 120000,
  })
}



export async function getProjectWorkflowState(projectIdentifier, { forceRefresh = false } = {}) {
  return cachedRequest(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/workflow-state`, {
    ttl: API_CACHE_TTL.projectDetail,
    timeoutMs: 60000,
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

export async function submitBusinessReviewTask(projectIdentifier, { requestId, inputRevision }) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/business-review/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, input_revision: inputRevision }),
    timeoutMs: 15000,
  })
}

export async function getLatestBusinessReviewTask(projectIdentifier) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/business-review/tasks/latest`, {
    timeoutMs: 10000,
  })
}

export async function getBusinessReviewTask(projectIdentifier, taskId) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/business-review/tasks/${encodeURIComponent(taskId)}`, {
    timeoutMs: 10000,
  })
}

// ─── 独立招标文件审查 ────────────────────────────────

export async function createTenderReview(file) {
  const formData = new FormData()
  formData.append('file', file)
  return request('/api/analysis/tender-reviews', {
    method: 'POST',
    body: formData,
  })
}

export async function listTenderReviews({ page = 1, pageSize = 50 } = {}) {
  return request('/api/analysis/tender-reviews', {
    query: { page, page_size: pageSize },
  })
}

export async function getTenderReview(reviewId) {
  return request(`/api/analysis/tender-reviews/${encodeURIComponent(reviewId)}`)
}

export async function rerunTenderReview(reviewId) {
  return request(`/api/analysis/tender-reviews/${encodeURIComponent(reviewId)}/rerun`, {
    method: 'POST',
  })
}

export async function deleteTenderReview(reviewId) {
  return request(`/api/analysis/tender-reviews/${encodeURIComponent(reviewId)}`, {
    method: 'DELETE',
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

export async function replaceProjectDocument(projectIdentifier, { documentIdentifier, documentType, file }) {
  const body = new FormData()
  body.append('document_identifier', documentIdentifier)
  body.append('document_type', documentType)
  body.append('file', file)
  try {
    return await request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifier)}/replace-document`, { method: 'POST', body })
  } finally {
    // Even a lost response may follow a committed replacement.
    invalidateProjectCache(projectIdentifier)
  }
}

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







// ─── Documents ───────────────────────────────────────







export async function getDocumentDownloadUrl(identifier) {
  return request(`/api/postgresql/documents/${encodeURIComponent(identifier)}/source`, { query: { as_json: true } })
}

export async function getProjectReportDownloadUrl(identifier) {
  return request(`/api/postgresql/projects/${encodeURIComponent(identifier)}/report-source`)
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





export async function exportProjectResultReport(projectIdentifierId, result) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectIdentifierId)}/export-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result }),
  })
}


// ─── Export Report ──────────────────────────────────
