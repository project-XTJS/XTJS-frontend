const DEFAULT_API_BASE_URL = ''

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

async function request(path, { method = 'GET', query, body, headers } = {}) {
  const response = await fetch(buildRequestUrl(path, query), {
    method,
    body,
    headers,
  })

  const payload = await parseResponseBody(response)
  return unwrapUnifiedPayload(payload, response)
}

// ─── Health ──────────────────────────────────────────

export async function probeBackend() {
  return request('/health')
}

// ─── Projects ────────────────────────────────────────

export async function listProjects({ page = 1, pageSize = 24, keyword } = {}) {
  return request('/api/postgresql/projects', {
    query: { page, page_size: pageSize, keyword },
  })
}

export async function getProjectDetail(identifierId) {
  return request(`/api/postgresql/projects/${encodeURIComponent(identifierId)}`)
}

export async function createProject(projectName) {
  return request('/api/postgresql/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_name: projectName }),
  })
}

export async function updateProjectIdentifier(identifierId, newProjectName) {
  return request(`/api/postgresql/projects/${encodeURIComponent(identifierId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_name: newProjectName }),
  })
}

export async function deleteProject(identifierId) {
  return request(`/api/postgresql/projects/${encodeURIComponent(identifierId)}`, {
    method: 'DELETE',
  })
}

export async function batchDeleteProjects(identifierIds) {
  return request('/api/postgresql/projects/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier_ids: identifierIds }),
  })
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

  return request('/api/postgresql/projects/batch/ingest-recognize', {
    method: 'POST',
    body: formData,
  })
}

// ─── Project Results ─────────────────────────────────

export async function getProjectResults(projectName) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/results`, {
    query: { view: 'display', include_raw_results: 'false', include_result_record: 'false' },
  })
}

export async function getProjectSingleResult(projectName, resultKey) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/results/${encodeURIComponent(resultKey)}`)
}

export async function getProjectVisualizationData(projectName) {
  return request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/visualization-data`)
}

// ─── OCR Execution ───────────────────────────────────

export async function runTenderOcr(projectName, { parallelism = 1 } = {}) {
  const formBody = new URLSearchParams()
  formBody.append('parallelism', `${parallelism}`)

  return request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/run-tender-ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  })
}

export async function runBusinessOcr(projectName, { parallelism = 1 } = {}) {
  const formBody = new URLSearchParams()
  formBody.append('parallelism', `${parallelism}`)

  return request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/run-business-ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  })
}

export async function continueTechnicalOcr(projectName, { parallelism = 1 } = {}) {
  const formBody = new URLSearchParams()
  formBody.append('parallelism', `${parallelism}`)

  return request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/continue-technical-ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  })
}

export async function runFullOcr(projectName, { parallelism = 1 } = {}) {
  const formBody = new URLSearchParams()
  formBody.append('parallelism', `${parallelism}`)

  return request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/run-full-ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  })
}

// ─── Analysis Execution ──────────────────────────────

export async function runAnalysis({
  projectIdentifier,
  services,
  maxEvidenceSections = 5,
  maxPairsPerType = 0,
}) {
  return request('/api/analysis/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_identifier: projectIdentifier,
      services,
      max_evidence_sections: maxEvidenceSections,
      max_pairs_per_type: maxPairsPerType,
    }),
  })
}

// ─── Relations ───────────────────────────────────────

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
  return request(`/api/postgresql/projects/${encodeURIComponent(projectName)}/bind-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tender_document_identifier: tenderDocumentIdentifier,
      business_bid_document_identifier: businessBidDocumentIdentifier,
      technical_bid_document_identifier: technicalBidDocumentIdentifier,
    }),
  })
}

export async function updateRelation(relationId, body) {
  return request(`/api/postgresql/relations/${relationId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteRelation(relationId) {
  return request(`/api/postgresql/relations/${relationId}`, {
    method: 'DELETE',
  })
}

export async function batchDeleteRelations(relationIds) {
  return request('/api/postgresql/relations/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relation_ids: relationIds }),
  })
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

  const response = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

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
  return request('/api/postgresql/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_identifier_id: projectIdentifierId, result }),
  })
}

export async function getSingleResult(projectIdentifierId) {
  return request(`/api/postgresql/results/${encodeURIComponent(projectIdentifierId)}`)
}

export async function updateResult(projectIdentifierId, result) {
  return request(`/api/postgresql/results/${encodeURIComponent(projectIdentifierId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result }),
  })
}

export async function updateResultForFrontend(projectIdentifierId, resultFotFrontend) {
  return request(`/api/postgresql/results/${encodeURIComponent(projectIdentifierId)}/frontend`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result_fot_frontend: resultFotFrontend }),
  })
}

export async function deleteResult(projectIdentifierId) {
  return request(`/api/postgresql/results/${encodeURIComponent(projectIdentifierId)}`, {
    method: 'DELETE',
  })
}

// ─── Export Report ──────────────────────────────────

export async function exportReport(identifierId, { alertIds, options = {} }) {
  const url = `${API_BASE_URL}/api/postgresql/projects/${encodeURIComponent(identifierId)}/export-report`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      alert_ids: alertIds,
      options: {
        include_screenshots: options.includeScreenshots || false,
        include_notes: options.includeNotes !== false,
        report_title: options.reportTitle || '',
      },
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw createApiError(`Export failed: ${response.status}`, {
      status: response.status,
      payload: errorText,
    })
  }

  return response.blob()
}
