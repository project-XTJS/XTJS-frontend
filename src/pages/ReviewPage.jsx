import { useCallback, useEffect, useState, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  getDocumentSourceUrl,
  getDocumentPreview,
  getProjectDetail,
  getProjectResults,
  listProjects,
} from '../lib/xtjsApi'
import { DOCUMENT_LABELS } from '../utils/formatters'
import EmptyBlock from '../components/EmptyBlock'
import ProjectDropdown from '../components/ProjectDropdown'

var RESULT_TYPE_LABELS = {
  duplicate_check: '全文查重',
  business_bid_duplicate_check: '商务标查重',
  technical_bid_duplicate_check: '技术标查重',
  business_bid_format_review: '形式审查',
  personnel_reuse_check: '人员复用',
  typo_check: '错字检查',
  bid_document_review: '综合审查',
}

var RESULT_TYPE_COLORS = {
  duplicate_check: '#dc2626',
  business_bid_duplicate_check: '#ea580c',
  technical_bid_duplicate_check: '#f59e0b',
  business_bid_format_review: '#2563eb',
  personnel_reuse_check: '#9333ea',
  typo_check: '#0891b2',
  bid_document_review: '#0f766e',
}

var KNOWN_RESULT_KEYS = [
  'duplicate_check',
  'business_bid_duplicate_check',
  'technical_bid_duplicate_check',
  'business_bid_format_review',
  'personnel_reuse_check',
  'typo_check',
  'bid_document_review',
  'business_bid_duplicate_clusters',
  'technical_bid_duplicate_clusters',
]

var FORMAT_CHECK_LABELS = {
  pricing_check: '报价校验',
  deviation_check: '偏离响应校验',
  integrity_check: '完整性校验',
  consistency_check: '格式一致性校验',
  verification_check: '签章日期校验',
  itemized_pricing_check: '分项报价校验',
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function arrayify(value) {
  return Array.isArray(value) ? value : []
}

function hasKnownResultShape(value) {
  if (!isObject(value)) return false
  return Object.keys(value).some(function (key) {
    return KNOWN_RESULT_KEYS.indexOf(key) >= 0 || /(_check|_review|_clusters)$/.test(key)
  })
}

function normalizeProjectResultsPayload(data) {
  if (!isObject(data)) return {}

  var candidates = [
    data.results,
    data.result,
    data.result_record && data.result_record.result,
    data.data && data.data.results,
    data.data && data.data.result,
    data,
  ]

  for (var i = 0; i < candidates.length; i++) {
    if (hasKnownResultShape(candidates[i])) {
      return candidates[i]
    }
  }

  return {}
}

function cloneForExport(value) {
  if (value === undefined || value === null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function compactObject(value) {
  var next = {}
  Object.entries(value).forEach(function (entry) {
    var key = entry[0]
    var item = entry[1]
    if (item !== undefined && item !== null && item !== '') {
      next[key] = item
    }
  })
  return next
}

function makeAlertId() {
  return Array.from(arguments).map(function (part) {
    return String(part === undefined || part === null ? '' : part)
  }).join('|')
}

function normalizeRiskLevel(value) {
  var text = String(value || '').toLowerCase()
  if (text === 'high' || text === 'error' || text === 'fail' || text === 'failed') return 'high'
  if (text === 'medium' || text === 'warning' || text === 'warn' || text === 'unclear') return 'medium'
  if (text === 'low') return 'low'
  return 'none'
}

function getGroupLabel(groupKey, fallback) {
  return DOCUMENT_LABELS[groupKey] || DOCUMENT_LABELS[fallback] || groupKey || fallback || ''
}

function getFirstNumber(value) {
  if (typeof value === 'number' && value > 0) return value
  if (typeof value === 'string' && Number(value) > 0) return Number(value)
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var nested = getFirstNumber(value[i])
      if (nested) return nested
    }
  }
  return null
}

function extractPageFromText(text) {
  var match = String(text || '').match(/第\s*(\d+)\s*页/)
  return match ? Number(match[1]) : null
}

function extractFirstPage(value) {
  if (!isObject(value)) return null

  var directKeys = ['page', 'page_no', 'page_num', 'page_number', 'pdf_page', 'start_page', 'left_page', 'right_page', 'response_page', 'source_page']
  for (var i = 0; i < directKeys.length; i++) {
    var direct = getFirstNumber(value[directKeys[i]])
    if (direct) return direct
  }

  var listKeys = ['pages', 'page_refs', 'left_pages', 'right_pages', 'section_pages']
  for (var li = 0; li < listKeys.length; li++) {
    var listed = getFirstNumber(value[listKeys[li]])
    if (listed) return listed
  }

  var textPage = extractPageFromText(value.message || value.summary || value.text)
  if (textPage) return textPage

  var entries = Object.entries(value)
  for (var ei = 0; ei < entries.length; ei++) {
    var nested = entries[ei][1]
    if (Array.isArray(nested)) {
      for (var ni = 0; ni < nested.length; ni++) {
        var nestedPage = extractFirstPage(nested[ni])
        if (nestedPage) return nestedPage
      }
    } else if (isObject(nested)) {
      var childPage = extractFirstPage(nested)
      if (childPage) return childPage
    }
  }

  return null
}

function normalizeDocRef(raw, fallback) {
  var source = raw || {}
  var base = fallback || {}
  var docId = source.document_identifier_id || source.identifier_id || source.doc_id || source.docId || base.docId
  var fileName = source.file_name || source.fileName || source.document_name || base.fileName
  var fileUrl = source.file_url || source.fileUrl || source.file_path || source.filePath ||
    source.minio_url || source.minioUrl || source.source_url || source.sourceUrl || base.fileUrl
  var label = source.label || fileName || base.label || docId
  var page = extractFirstPage(source) || base.page || base.startPage || 1

  if (!docId && !fileName && !fileUrl) return null

  return compactObject({
    docId: docId,
    fileName: fileName,
    fileUrl: fileUrl,
    docKey: docId || fileName || label,
    label: label,
    startPage: page,
    pageCount: source.page_count || source.pageCount || base.pageCount,
    role: source.role || base.role,
    purpose: source.purpose || base.purpose,
    documentType: source.document_type || source.documentType || base.documentType,
    highlight: source.highlight || base.highlight,
    highlightBbox: source.highlightBbox || source.bbox || base.highlightBbox,
    highlightRects: source.highlightRects || base.highlightRects,
  })
}

function getLookupKey(value) {
  return String(value || '').trim().toLowerCase()
}

function addDocumentToLookup(lookup, doc) {
  if (!doc || (!doc.docId && !doc.fileName && !doc.fileUrl)) return

  var value = compactObject(doc)
  var aliases = [
    value.docId,
    value.fileName,
    value.fileUrl,
    value.label,
    value.fileName && value.docId ? value.fileName + ' (' + value.docId + ')' : '',
  ]

  aliases.forEach(function (alias) {
    var key = getLookupKey(alias)
    if (key) lookup[key] = value
  })
}

function looksLikeDocument(value) {
  if (!isObject(value)) return false
  return Boolean(
    value.file_name ||
    value.fileName ||
    value.document_name ||
    value.identifier_id ||
    value.document_identifier_id ||
    value.file_url ||
    value.fileUrl ||
    value.file_path ||
    value.filePath ||
    value.minio_url ||
    value.minioUrl,
  )
}

function documentCandidatesFromValue(value) {
  if (Array.isArray(value)) {
    var list = []
    value.forEach(function (item) {
      list = list.concat(documentCandidatesFromValue(item))
    })
    return list
  }
  if (!isObject(value)) return []
  if (looksLikeDocument(value)) return [value]

  var candidates = []
  Object.entries(value).forEach(function (entry) {
    var key = entry[0]
    var doc = entry[1]
    if (!isObject(doc)) return
    if (looksLikeDocument(doc)) {
      candidates.push(Object.assign({ role: doc.role || key }, doc))
      return
    }
    documentCandidatesFromValue(doc).forEach(function (nestedDoc) {
      candidates.push(Object.assign({ role: nestedDoc.role || key }, nestedDoc))
    })
  })
  return candidates
}

function buildInlineDocumentLookup() {
  var lookup = {}

  Array.from(arguments).forEach(function (value) {
    documentCandidatesFromValue(value).forEach(function (doc) {
      var normalized = normalizeDocRef(doc, {})
      if (!normalized) return

      addDocumentToLookup(lookup, normalized)
      if (normalized.role) lookup['role:' + getLookupKey(normalized.role)] = normalized
      if (normalized.purpose) lookup['purpose:' + getLookupKey(normalized.purpose)] = normalized
      if (normalized.documentType) lookup['type:' + getLookupKey(normalized.documentType)] = normalized
    })
  })

  return lookup
}

function mergeDocumentCandidate(doc, lookup) {
  var role = doc && doc.role
  var purpose = doc && doc.purpose
  var documentType = doc && (doc.document_type || doc.documentType)
  var match = lookup[getLookupKey(doc && (doc.document_identifier_id || doc.identifier_id || doc.docId))] ||
    lookup[getLookupKey(doc && (doc.file_name || doc.fileName))] ||
    lookup[getLookupKey(doc && (doc.file_url || doc.fileUrl || doc.file_path || doc.filePath))] ||
    lookup['role:' + getLookupKey(role)] ||
    lookup['purpose:' + getLookupKey(purpose)] ||
    lookup['type:' + getLookupKey(documentType)]

  return match ? Object.assign({}, match, doc) : doc
}

function buildProjectDocumentLookup(projectDetail) {
  var lookup = {}
  var relations = arrayify(projectDetail && projectDetail.relations)

  relations.forEach(function (relation) {
    addDocumentToLookup(lookup, {
      docId: relation.tender_identifier_id,
      fileName: relation.tender_file_name,
      fileUrl: relation.tender_file_url,
      documentType: relation.tender_document_type || 'tender',
      label: relation.tender_file_name,
    })
    addDocumentToLookup(lookup, {
      docId: relation.business_bid_identifier_id,
      fileName: relation.business_bid_file_name,
      fileUrl: relation.business_bid_file_url,
      documentType: relation.business_bid_document_type || 'business_bid',
      label: relation.business_bid_file_name,
    })
    addDocumentToLookup(lookup, {
      docId: relation.technical_bid_identifier_id,
      fileName: relation.technical_bid_file_name,
      fileUrl: relation.technical_bid_file_url,
      documentType: relation.technical_bid_document_type || 'technical_bid',
      label: relation.technical_bid_file_name,
    })
  })

  return lookup
}

function enrichDocWithProjectFile(doc, lookup) {
  var match = lookup[getLookupKey(doc.docId)] ||
    lookup[getLookupKey(doc.fileName)] ||
    lookup[getLookupKey(doc.fileUrl)] ||
    lookup[getLookupKey(doc.label)]

  var sourceRef = (match && match.docId) || doc.docId || doc.fileName
  return compactObject(Object.assign({}, doc, {
    docId: (match && match.docId) || doc.docId,
    fileName: (match && match.fileName) || doc.fileName,
    fileUrl: doc.fileUrl || (match && match.fileUrl),
    documentType: (match && match.documentType) || doc.documentType,
    label: doc.label || (match && match.label) || (match && match.fileName),
    sourceRef: sourceRef,
    docKey: doc.docKey || sourceRef || (match && match.fileName),
  }))
}

function enrichAlertsWithProjectFiles(alerts, projectDetail) {
  var lookup = buildProjectDocumentLookup(projectDetail)
  return alerts.map(function (alert) {
    return Object.assign({}, alert, {
      documents: arrayify(alert.documents).map(function (doc) {
        return enrichDocWithProjectFile(doc, lookup)
      }),
    })
  })
}

function buildExportPayload(alert, item) {
  var source = isObject(item) ? cloneForExport(item) : { value: item }
  return compactObject(Object.assign({
    result_key: alert.sourceResultKey || alert.resultType,
    review_item: alert.subType,
    group: alert.groupKey,
  }, source))
}

function collectDuplicateAlerts(results, allAlerts) {
  var duplicateKeys = []
  if (results.business_bid_duplicate_check) duplicateKeys.push('business_bid_duplicate_check')
  if (results.technical_bid_duplicate_check) duplicateKeys.push('technical_bid_duplicate_check')
  if (duplicateKeys.length === 0 && results.duplicate_check) duplicateKeys.push('duplicate_check')

  duplicateKeys.forEach(function (resultKey) {
    var result = results[resultKey]
    if (!result || !result.groups) return

    Object.entries(result.groups).forEach(function (entry) {
      var groupKey = entry[0]
      var groupValue = entry[1] || {}
      var items = arrayify(groupValue.items)

      items.forEach(function (item, index) {
        if (item.suspicious === false) return

        var firstBlock = arrayify(item.duplicate_blocks)[0] ||
          arrayify(item.similar_blocks)[0] ||
          arrayify(item.duplicate_tables)[0] ||
          arrayify(item.duplicate_sections)[0] ||
          {}
        var leftPage = firstBlock.left_page || getFirstNumber(firstBlock.left_pages) || firstBlock.page || 1
        var rightPage = firstBlock.right_page || getFirstNumber(firstBlock.right_pages) || firstBlock.page || 1
        var leftDoc = normalizeDocRef({
          identifier_id: item.left_document_identifier,
          file_name: item.left_file_name,
          file_url: item.left_file_url || item.left_file_path || item.left_document_url || item.left_document_file_url,
          page: leftPage,
          highlight: firstBlock.left_text || firstBlock.text || firstBlock.left_preview,
        }, { label: '文档 A', page: leftPage })
        var rightDoc = normalizeDocRef({
          identifier_id: item.right_document_identifier,
          file_name: item.right_file_name,
          file_url: item.right_file_url || item.right_file_path || item.right_document_url || item.right_document_file_url,
          page: rightPage,
          highlight: firstBlock.right_text || firstBlock.text || firstBlock.right_preview,
        }, { label: '文档 B', page: rightPage })
        var docs = [leftDoc, rightDoc].filter(Boolean)
        var score = item.match_score || item.exact_match_score

        var alert = {
          id: makeAlertId('duplicate', resultKey, groupKey, item.left_document_identifier || item.left_file_name, item.right_document_identifier || item.right_file_name, index),
          resultType: resultKey,
          sourceResultKey: resultKey,
          resultTypeLabel: RESULT_TYPE_LABELS[resultKey] || RESULT_TYPE_LABELS.duplicate_check,
          groupKey: groupKey,
          groupLabel: getGroupLabel(groupKey, item.document_type),
          riskLevel: normalizeRiskLevel(item.risk_level || (item.suspicious ? 'medium' : 'none')),
          title: (item.left_file_name || '文档 A') + ' / ' + (item.right_file_name || '文档 B'),
          description: '匹配得分 ' + (score === undefined || score === null ? '--' : score),
          metrics: {
            '完全重复块': (item.metrics && item.metrics.exact_block_count) || arrayify(item.duplicate_blocks).length,
            '相似块': (item.metrics && item.metrics.similar_block_count) || arrayify(item.similar_blocks).length,
            '重复表格': (item.metrics && item.metrics.exact_table_count) || arrayify(item.duplicate_tables).length,
          },
          evidence: {
            duplicateBlocks: arrayify(item.duplicate_blocks),
            similarBlocks: arrayify(item.similar_blocks),
            duplicateTables: arrayify(item.duplicate_tables),
            duplicateSections: arrayify(item.duplicate_sections),
          },
          documents: docs,
          page: leftPage,
          sourceItem: item,
        }

        alert.exportPayload = buildExportPayload(alert, item)
        allAlerts.push(alert)
      })
    })
  })
}

function collectTypoAlertsFromGroups(resultKey, result, allAlerts, options) {
  if (!result || !result.groups) return
  var opts = options || {}

  Object.entries(result.groups).forEach(function (entry) {
    var groupKey = entry[0]
    var groupValue = entry[1] || {}
    var docs = arrayify(groupValue.typo_check && groupValue.typo_check.documents)

    docs.forEach(function (doc, docIndex) {
      arrayify(doc.items).forEach(function (item, itemIndex) {
        var page = item.page || 1
        var fileName = item.file_name || doc.file_name
        var docRef = normalizeDocRef({
          document_identifier_id: item.document_identifier_id || doc.identifier_id,
          file_name: fileName,
          file_url: item.file_url || item.file_path || doc.file_url || doc.file_path,
          page: page,
          bbox: item.bbox,
          highlight: item.matched_text,
        }, { page: page })
        var label = opts.resultTypeLabel || RESULT_TYPE_LABELS[resultKey] || resultKey

        var alert = {
          id: makeAlertId('typo', resultKey, groupKey, item.document_identifier_id || doc.identifier_id || fileName, page, item.issue_key, docIndex, itemIndex),
          resultType: opts.resultType || resultKey,
          sourceResultKey: resultKey,
          subType: opts.subType,
          resultTypeLabel: label,
          groupKey: groupKey,
          groupLabel: getGroupLabel(groupKey),
          riskLevel: 'medium',
          title: '错字：' + (item.matched_text || item.issue_key || '疑似错字'),
          description: (fileName || '未知文件') + ' 第 ' + page + ' 页，建议改为 ' + (item.suggestion || '请人工确认'),
          metrics: {
            '文件': fileName || '--',
            '页码': page,
            '建议': item.suggestion || '--',
          },
          evidence: {
            matchedText: item.matched_text,
            suggestion: item.suggestion,
            page: page,
            bbox: item.bbox,
            text: item.text,
          },
          documents: docRef ? [docRef] : [],
          page: page,
          sourceItem: item,
        }

        alert.exportPayload = buildExportPayload(alert, Object.assign({}, item, {
          file_name: fileName,
          document_identifier_id: item.document_identifier_id || doc.identifier_id,
        }))
        allAlerts.push(alert)
      })
    })
  })
}

function collectPersonnelAlertsFromGroups(resultKey, result, allAlerts, options) {
  if (!result || !result.groups) return
  var opts = options || {}

  Object.entries(result.groups).forEach(function (entry) {
    var groupKey = entry[0]
    var groupValue = entry[1] || {}
    var check = groupValue.personnel_reuse_check || {}
    var items = arrayify(check.items)

    items.forEach(function (item, index) {
      var evidenceDocs = arrayify(item.documents)
      if (evidenceDocs.length === 0) evidenceDocs = arrayify(item.items)
      if (evidenceDocs.length === 0) evidenceDocs = arrayify(item.evidence && item.evidence.documents)
      if (evidenceDocs.length === 0) evidenceDocs = arrayify(check.documents)
      if (evidenceDocs.length === 0) evidenceDocs = arrayify(groupValue.documents)

      var docs = evidenceDocs.map(function (doc) {
        return normalizeDocRef(doc, { page: 1 })
      }).filter(Boolean)
      var documentCount = item.document_count || docs.length || item.occurrence_count || 0
      var name = item.name || item.person_name || item.personnel_name || '疑似复用人员'
      var label = opts.resultTypeLabel || RESULT_TYPE_LABELS[resultKey] || resultKey

      var alert = {
        id: makeAlertId('personnel', resultKey, groupKey, name, index),
        resultType: opts.resultType || resultKey,
        sourceResultKey: resultKey,
        subType: opts.subType,
        resultTypeLabel: label,
        groupKey: groupKey,
        groupLabel: getGroupLabel(groupKey, groupValue.document_type),
        riskLevel: normalizeRiskLevel(item.risk_level || (documentCount > 2 ? 'high' : 'medium')),
        title: name,
        description: '在 ' + documentCount + ' 份文档中重复出现',
        metrics: {
          '涉及文档': documentCount,
          '出现次数': item.occurrence_count || '--',
          '角色': arrayify(item.roles).join('、') || item.role || '--',
        },
        evidence: {
          documents: evidenceDocs,
          roles: item.roles,
          items: item.items,
        },
        documents: docs,
        page: docs[0] && docs[0].startPage,
        sourceItem: item,
      }

      alert.exportPayload = buildExportPayload(alert, item)
      allAlerts.push(alert)
    })
  })
}

function collectFormatReviewAlerts(results, allAlerts) {
  var result = results.business_bid_format_review
  if (!result) return

  arrayify(result.bidders).forEach(function (bidder, bidderIndex) {
    var bidderDocumentLookup = buildInlineDocumentLookup(
      bidder.documents,
      result.dataset && result.dataset.tender,
      result.dataset && result.dataset.bidders
    )

    Object.entries(bidder.checks || {}).forEach(function (entry) {
      var checkKey = entry[0]
      var check = entry[1] || {}
      var failedIssues = arrayify(check.issues && check.issues.failed)
      var unclearIssues = arrayify(check.issues && check.issues.unclear)
      var issues = failedIssues.concat(unclearIssues)
      var reviewStatus = check.review && check.review.status

      if (issues.length === 0 && normalizeRiskLevel(reviewStatus) !== 'none') {
        issues = [{
          title: check.check_name || FORMAT_CHECK_LABELS[checkKey] || checkKey,
          status: reviewStatus,
          message: check.review && check.review.summary,
          evidence: check.raw_result && check.raw_result.summary,
          severity: reviewStatus === 'fail' ? 'error' : 'warning',
        }]
      }

      issues.forEach(function (issue, issueIndex) {
        var page = extractFirstPage(issue) ||
          extractFirstPage(issue.evidence) ||
          extractFirstPage(check.raw_result) ||
          extractPageFromText(issue.message || (check.review && check.review.summary)) ||
          1
        var sourceDocs = arrayify(check.source_context && check.source_context.source_documents)
        if (sourceDocs.length === 0) sourceDocs = documentCandidatesFromValue(bidder.documents)
        sourceDocs = sourceDocs.map(function (doc) {
          return mergeDocumentCandidate(doc, bidderDocumentLookup)
        })
        var docRefs = sourceDocs.map(function (doc, docIndex) {
          return normalizeDocRef(doc, {
            fileName: doc.file_name || bidder.file_name,
            page: extractFirstPage(doc) || page,
            label: doc.file_name || doc.role || bidder.bidder_name || ('关联文档 ' + (docIndex + 1)),
          })
        }).filter(Boolean)
        var docRef = docRefs.find(function (doc) {
          return doc.role === 'business' || doc.purpose === 'business_bid_source' || doc.purpose === 'quoted_price_source'
        }) || docRefs[0]
        var checkLabel = check.check_name || FORMAT_CHECK_LABELS[checkKey] || checkKey
        var riskLevel = normalizeRiskLevel(issue.severity || issue.status || reviewStatus)

        var alert = {
          id: makeAlertId('format', bidder.bidder_key || bidder.bidder_name || bidderIndex, checkKey, issue.title, issueIndex),
          resultType: 'business_bid_format_review',
          sourceResultKey: 'business_bid_format_review',
          subType: checkKey,
          resultTypeLabel: RESULT_TYPE_LABELS.business_bid_format_review,
          groupKey: 'business_bid',
          groupLabel: DOCUMENT_LABELS.business_bid,
          riskLevel: riskLevel === 'none' ? 'medium' : riskLevel,
          title: checkLabel + '：' + (issue.title || '需人工复核'),
          description: (bidder.bidder_name || bidder.bidder_key || '投标人') + ' - ' + (issue.message || (check.review && check.review.summary) || '发现需复核项'),
          metrics: {
            '投标人': bidder.bidder_name || bidder.bidder_key || '--',
            '审查项': checkLabel,
            '页码': page || '--',
          },
          evidence: {
            issue: issue,
            reviewSummary: check.review && check.review.summary,
            documents: sourceDocs,
          },
          documents: docRefs,
          page: page,
          sourceItem: issue,
        }

        alert.exportPayload = compactObject({
          result_key: 'business_bid_format_review',
          bidder_key: bidder.bidder_key,
          bidder_name: bidder.bidder_name,
          check_code: check.check_code || checkKey,
          check_name: checkLabel,
          file_name: docRef && docRef.fileName,
          page: page,
          issue: cloneForExport(issue),
        })
        allAlerts.push(alert)
      })
    })
  })
}

function collectAllAlerts(results) {
  if (!results) return []

  var allAlerts = []

  collectDuplicateAlerts(results, allAlerts)
  collectTypoAlertsFromGroups('typo_check', results.typo_check, allAlerts)
  collectPersonnelAlertsFromGroups('personnel_reuse_check', results.personnel_reuse_check, allAlerts)
  collectFormatReviewAlerts(results, allAlerts)

  collectTypoAlertsFromGroups('bid_document_review', results.bid_document_review, allAlerts, {
    resultType: 'bid_document_review',
    resultTypeLabel: RESULT_TYPE_LABELS.bid_document_review,
    subType: 'typo_check',
  })
  collectPersonnelAlertsFromGroups('bid_document_review', results.bid_document_review, allAlerts, {
    resultType: 'bid_document_review',
    resultTypeLabel: RESULT_TYPE_LABELS.bid_document_review,
    subType: 'personnel_reuse_check',
  })

  var order = { high: 3, medium: 2, low: 1, none: 0 }
  return allAlerts.sort(function (a, b) {
    return (order[b.riskLevel] || 0) - (order[a.riskLevel] || 0)
  })
}

var RISK_CLASSES = {
  high: 'risk-high',
  medium: 'risk-medium',
  low: 'risk-low',
  none: 'risk-none',
}

var RISK_LABELS = {
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  none: 'NONE',
}

// Extract document list from an alert for PDF preview rendering
function getAlertDocIds(alert) {
  if (alert && alert.documents && alert.documents.length > 0) {
    return alert.documents
  }

  var docs = []

  // Duplicate check: left + right documents
  if (alert.leftDocumentId && alert.rightDocumentId) {
    var dupBlocks = alert.evidence && alert.evidence.duplicateBlocks
    var firstBlock = dupBlocks && dupBlocks[0]
    docs.push({
      docId: alert.leftDocumentId,
      docKey: alert.leftDocumentId,
      label: alert.leftFileName || '文档 A',
      startPage: (firstBlock && (firstBlock.left_page || firstBlock.page)) || 1,
    })
    docs.push({
      docId: alert.rightDocumentId,
      docKey: alert.rightDocumentId,
      label: alert.rightFileName || '文档 B',
      startPage: (firstBlock && firstBlock.right_page) || 1,
    })
    return docs
  }

  // Single document (typo, review-typo)
  if (alert.documentId) {
    docs.push({
      docId: alert.documentId,
      docKey: alert.documentId,
      label: alert.title || '文档',
      startPage: (alert.evidence && alert.evidence.page) || 1,
    })
    return docs
  }

  // Personnel reuse: multiple documents
  var personnelDocs = (alert.evidence && alert.evidence.documents) || []
  for (var i = 0; i < personnelDocs.length; i++) {
    var d = personnelDocs[i]
    if (d.identifier_id) {
      docs.push({
        docId: d.identifier_id,
        docKey: d.identifier_id,
        label: d.file_name || ('文档 ' + (i + 1)),
        startPage: 1,
      })
    }
  }

  return docs
}

function formatHighlightBbox(bbox) {
  return Array.isArray(bbox) ? bbox.join(',') : bbox
}

function getPreviewOptions(docInfo) {
  return {
    highlight: docInfo.highlight,
    highlightBbox: formatHighlightBbox(docInfo.highlightBbox),
    highlightRects: docInfo.highlightRects,
  }
}

function uniqueValues(values) {
  var seen = {}
  return values.filter(function (value) {
    var key = String(value || '')
    if (!key || seen[key]) return false
    seen[key] = true
    return true
  })
}

function getPreviewTargets(docInfo) {
  return uniqueValues([docInfo.sourceRef, docInfo.docId, docInfo.fileName])
}

function getPreviewPageCount(preview, docInfo) {
  return (preview && preview.page_count) || docInfo.pageCount || null
}

function getPreviewCurrentPage(preview, fallbackPage) {
  return (preview && preview.page) || fallbackPage || 1
}

function getPreviewStartPage(docInfo, alert) {
  return docInfo.startPage ||
    (alert && alert.page) ||
    (alert && alert.evidence && alert.evidence.page) ||
    1
}

async function fetchDocumentPreviewForDoc(docInfo, page) {
  var targets = getPreviewTargets(docInfo)
  var lastError = null

  for (var i = 0; i < targets.length; i++) {
    try {
      return await getDocumentPreview(targets[i], page, getPreviewOptions(docInfo))
    } catch (error) {
      lastError = error
    }
  }

  throw lastError || new Error('无法加载预览')
}

function buildFilteredResultJson(alerts, selectedAlertIds) {
  return {
    result: alerts
      .filter(function (alert) { return selectedAlertIds.has(alert.id) })
      .map(function (alert) {
        return cloneForExport(alert.exportPayload || buildExportPayload(alert, alert.sourceItem))
      }),
  }
}

function downloadJsonFile(fileName, payload) {
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  var url = window.URL.createObjectURL(blob)
  var a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.URL.revokeObjectURL(url)
}

function downloadUrl(url, fileName) {
  var a = document.createElement('a')
  a.href = url
  if (fileName) a.download = fileName
  a.target = '_blank'
  a.rel = 'noreferrer'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

export default function ReviewPage() {
  var [searchParams, setSearchParams] = useSearchParams()
  var [projects, setProjects] = useState([])
  var [selectedProjectId, setSelectedProjectId] = useState(searchParams.get('projectId') || '')
  var [results, setResults] = useState(null)
  var [allAlerts, setAllAlerts] = useState([])
  var [currentServiceType, setCurrentServiceType] = useState(null)
  var [currentAlertIndex, setCurrentAlertIndex] = useState(0)
  var [reviewStatus, setReviewStatus] = useState({})
  var [reviewNotes, setReviewNotes] = useState({})
  var [showExport, setShowExport] = useState(false)
  var [notice, setNotice] = useState(null)
  var [isLoading, setIsLoading] = useState(true)
  var [selectedAlerts, setSelectedAlerts] = useState(new Set())
  // PDF preview state
  var [previewData, setPreviewData] = useState({})
  var [previewPages, setPreviewPages] = useState({})
  var [previewPageInputs, setPreviewPageInputs] = useState({})
  var [previewBusy, setPreviewBusy] = useState({})
  var [previewErrors, setPreviewErrors] = useState({})
  var [previewLoading, setPreviewLoading] = useState(false)
  var [previewZoom, setPreviewZoom] = useState(60)
  var [previewLightbox, setPreviewLightbox] = useState(null)
  var [exportLoading, setExportLoading] = useState(false)
  var exportModalRef = useRef(null)

  var loadProjects = useCallback(function () {
    listProjects({ pageSize: 100 }).then(function (listing) {
      setProjects(listing.items || [])
    }).catch(function () {
      // ignore
    })
  }, [])

  var loadData = useCallback(function (projectId) {
    if (!projectId) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    Promise.all([
      getProjectResults(projectId),
      getProjectDetail(projectId).catch(function () { return null }),
    ]).then(function (responses) {
      var data = responses[0]
      var projectDetail = responses[1]
      var projectResults = normalizeProjectResultsPayload(data)
      setResults(projectResults)
      var alerts = enrichAlertsWithProjectFiles(collectAllAlerts(projectResults), projectDetail)
      setAllAlerts(alerts)
      setSelectedAlerts(new Set())

      // Auto-select first service type that has alerts
      var availableTypes = []
      alerts.forEach(function (alert) {
        if (availableTypes.indexOf(alert.resultType) < 0) {
          availableTypes.push(alert.resultType)
        }
      })
      var firstTypeWithAlerts = availableTypes.length > 0 ? availableTypes[0] : null
      if (!firstTypeWithAlerts) {
        var rawTypes = Object.keys(projectResults).filter(function (k) { return projectResults[k] })
        for (var ti = 0; ti < rawTypes.length; ti++) {
          if (alerts.some(function (a) { return a.sourceResultKey === rawTypes[ti] })) {
            firstTypeWithAlerts = rawTypes[ti]
            break
          }
        }
      }
      if (!firstTypeWithAlerts && alerts.length > 0) {
        firstTypeWithAlerts = alerts[0].resultType
      }
      setCurrentServiceType(firstTypeWithAlerts)
      setCurrentAlertIndex(0)
    }).catch(function () {
      setNotice({ type: 'error', message: '加载项目结果失败' })
    }).finally(function () {
      setIsLoading(false)
    })
  }, [])

  useEffect(function () {
    loadProjects()
  }, [loadProjects])

  useEffect(function () {
    loadData(selectedProjectId)
  }, [selectedProjectId, loadData])

  useEffect(function () {
    if (!previewLightbox) return undefined

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setPreviewLightbox(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return function () {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [previewLightbox])

  function handleProjectChange(projectId) {
    setSelectedProjectId(projectId)
    setSearchParams(projectId ? { projectId } : {})
    setReviewStatus({})
    setReviewNotes({})
    setSelectedAlerts(new Set())
    setPreviewData({})
    setPreviewPages({})
    setPreviewPageInputs({})
    setPreviewBusy({})
    setPreviewErrors({})
    setCurrentServiceType(null)
    setCurrentAlertIndex(0)
  }

  // Compute alerts for current service type
  var serviceAlerts = currentServiceType
    ? allAlerts.filter(function (a) { return a.resultType === currentServiceType })
    : []

  var currentAlert = serviceAlerts[currentAlertIndex] || null

  // Load previews for current alert
  useEffect(function () {
    if (!currentAlert) {
      setPreviewData({})
      setPreviewPageInputs({})
      setPreviewErrors({})
      setPreviewBusy({})
      return
    }

    var docIds = getAlertDocIds(currentAlert)
    if (docIds.length === 0) {
      setPreviewData({})
      setPreviewPageInputs({})
      setPreviewErrors({})
      setPreviewBusy({})
      return
    }

    setPreviewLoading(true)
    setPreviewErrors({})
    setPreviewBusy({})
    var cancelled = false

    var pages = {}
    docIds.forEach(function (d) {
      var docKey = d.docKey || d.docId || d.fileName || d.label
      pages[docKey] = getPreviewStartPage(d, currentAlert)
    })

    Promise.all(docIds.map(function (d) {
      var docKey = d.docKey || d.docId || d.fileName || d.label
      if (getPreviewTargets(d).length === 0) {
        return Promise.resolve({ docKey: docKey, preview: null })
      }
      return fetchDocumentPreviewForDoc(d, pages[docKey])
        .then(function (preview) {
          return { docKey: docKey, preview: preview }
        })
        .catch(function (error) {
          return { docKey: docKey, preview: null, error: error }
        })
    })).then(function (results) {
      if (cancelled) return
      var newData = {}
      var newErrors = {}
      var nextPages = {}
      for (var key in pages) { nextPages[key] = pages[key] }
      results.forEach(function (r) {
        newData[r.docKey] = r.preview
        if (r.preview) {
          nextPages[r.docKey] = getPreviewCurrentPage(r.preview, pages[r.docKey])
        }
        if (r.error) {
          newErrors[r.docKey] = '预览加载失败，请稍后重试'
        }
      })
      setPreviewData(newData)
      setPreviewPages(nextPages)
      var nextInputs = {}
      Object.entries(nextPages).forEach(function (entry) {
        nextInputs[entry[0]] = String(entry[1])
      })
      setPreviewPageInputs(nextInputs)
      setPreviewErrors(newErrors)
      setPreviewBusy({})
      setPreviewLoading(false)
    })

    return function () { cancelled = true }
  }, [currentAlert])

  function selectServiceType(key) {
    setCurrentServiceType(key)
    setCurrentAlertIndex(0)
    setPreviewData({})
    setPreviewPages({})
    setPreviewPageInputs({})
    setPreviewBusy({})
    setPreviewErrors({})
  }

  function goToPrev() {
    if (currentAlertIndex > 0) {
      setCurrentAlertIndex(function (i) { return i - 1 })
      setPreviewData({})
      setPreviewPages({})
      setPreviewPageInputs({})
      setPreviewBusy({})
      setPreviewErrors({})
    }
  }

  function goToNext() {
    if (currentAlertIndex < serviceAlerts.length - 1) {
      setCurrentAlertIndex(function (i) { return i + 1 })
      setPreviewData({})
      setPreviewPages({})
      setPreviewPageInputs({})
      setPreviewBusy({})
      setPreviewErrors({})
    }
  }

  async function handleDocPageChange(docInfo, delta) {
    var docKey = docInfo.docKey || docInfo.docId || docInfo.fileName || docInfo.label
    if (getPreviewTargets(docInfo).length === 0) return

    var currentPage = previewPages[docKey] || getPreviewStartPage(docInfo, currentAlert)
    var existing = previewData[docKey]
    var pageCount = getPreviewPageCount(existing, docInfo)
    var newPage = currentPage + delta
    if (newPage < 1) return
    if (pageCount && newPage > pageCount) return

    setPreviewPages(function (prev) {
      var next = {}
      for (var k in prev) { next[k] = prev[k] }
      next[docKey] = newPage
      return next
    })
    setPreviewPageInputs(function (prev) {
      var next = {}
      for (var k in prev) { next[k] = prev[k] }
      next[docKey] = String(newPage)
      return next
    })
    setPreviewBusy(function (prev) {
      var next = {}
      for (var k in prev) { next[k] = prev[k] }
      next[docKey] = true
      return next
    })
    setPreviewErrors(function (prev) {
      var next = {}
      for (var k in prev) { next[k] = prev[k] }
      delete next[docKey]
      return next
    })

    try {
      var preview = await fetchDocumentPreviewForDoc(docInfo, newPage)
      setPreviewData(function (prev) {
        var next = {}
        for (var k in prev) { next[k] = prev[k] }
        next[docKey] = preview
        return next
      })
      setPreviewPages(function (prev) {
        var next = {}
        for (var k in prev) { next[k] = prev[k] }
        next[docKey] = getPreviewCurrentPage(preview, newPage)
        return next
      })
      setPreviewPageInputs(function (prev) {
        var next = {}
        for (var k in prev) { next[k] = prev[k] }
        next[docKey] = String(getPreviewCurrentPage(preview, newPage))
        return next
      })
    } catch (e) {
      setPreviewErrors(function (prev) {
        var next = {}
        for (var k in prev) { next[k] = prev[k] }
        next[docKey] = '第 ' + newPage + ' 页加载失败'
        return next
      })
    } finally {
      setPreviewBusy(function (prev) {
        var next = {}
        for (var k in prev) { next[k] = prev[k] }
        delete next[docKey]
        return next
      })
    }
  }

  function handlePageInputChange(docInfo, value) {
    var docKey = docInfo.docKey || docInfo.docId || docInfo.fileName || docInfo.label
    setPreviewPageInputs(function (prev) {
      var next = {}
      for (var k in prev) { next[k] = prev[k] }
      next[docKey] = value.replace(/[^\d]/g, '')
      return next
    })
  }

  async function handleDocPageJump(docInfo) {
    var docKey = docInfo.docKey || docInfo.docId || docInfo.fileName || docInfo.label
    if (getPreviewTargets(docInfo).length === 0) return

    var targetPage = Number(previewPageInputs[docKey])
    if (!targetPage || targetPage < 1) return

    var existing = previewData[docKey]
    var pageCount = getPreviewPageCount(existing, docInfo)
    var nextPage = pageCount ? Math.min(targetPage, pageCount) : targetPage
    var currentPage = previewPages[docKey] || getPreviewStartPage(docInfo, currentAlert)
    if (nextPage === currentPage) {
      setPreviewPageInputs(function (prev) {
        var next = {}
        for (var k in prev) { next[k] = prev[k] }
        next[docKey] = String(nextPage)
        return next
      })
      return
    }

    await handleDocPageChange(docInfo, nextPage - currentPage)
  }

  function handleDownloadPdf(docInfo) {
    var target = getPreviewTargets(docInfo)[0]
    if (!target) {
      setNotice({ type: 'error', message: '当前文档缺少下载标识' })
      return
    }

    downloadUrl(getDocumentSourceUrl(target), docInfo.fileName || docInfo.label || 'document.pdf')
  }

  function handleReview(alertId, status) {
    setReviewStatus(function (prev) {
      var next = {}
      for (var key in prev) { next[key] = prev[key] }
      next[alertId] = { status: status, reviewedAt: new Date().toISOString() }
      return next
    })
    setSelectedAlerts(function (prev) {
      var next = new Set(prev)
      if (status === 'flagged') {
        next.add(alertId)
      } else {
        next.delete(alertId)
      }
      return next
    })
  }

  function handleNote(alertId, note) {
    setReviewNotes(function (prev) {
      var next = {}
      for (var key in prev) { next[key] = prev[key] }
      next[alertId] = note
      return next
    })
  }

  function toggleAlertSelection(alertId) {
    var shouldKeep = !selectedAlerts.has(alertId)
    setSelectedAlerts(function (prev) {
      var next = new Set(prev)
      if (shouldKeep) {
        next.add(alertId)
      } else {
        next.delete(alertId)
      }
      return next
    })
    setReviewStatus(function (current) {
      var statusMap = {}
      for (var key in current) { statusMap[key] = current[key] }
      statusMap[alertId] = {
        status: shouldKeep ? 'flagged' : 'passed',
        reviewedAt: new Date().toISOString(),
      }
      return statusMap
    })
  }

  // Select/deselect all alerts in current service type
  function toggleSelectAllCurrent() {
    if (!currentServiceType) return
    var allSelected = serviceAlerts.length > 0 && serviceAlerts.every(function (a) { return selectedAlerts.has(a.id) })
    setSelectedAlerts(function (prev) {
      if (allSelected) {
        var deselected = new Set(prev)
        serviceAlerts.forEach(function (a) { deselected.delete(a.id) })
        return deselected
      }
      var selected = new Set(prev)
      serviceAlerts.forEach(function (a) { selected.add(a.id) })
      return selected
    })
    setReviewStatus(function (current) {
      var statusMap = {}
      for (var key in current) { statusMap[key] = current[key] }
      serviceAlerts.forEach(function (alert) {
        statusMap[alert.id] = {
          status: allSelected ? 'passed' : 'flagged',
          reviewedAt: new Date().toISOString(),
        }
      })
      return statusMap
    })
  }

  function batchPassAll() {
    var newStatus = {}
    for (var key in reviewStatus) { newStatus[key] = reviewStatus[key] }
    serviceAlerts.forEach(function (alert) {
      if (!newStatus[alert.id]) {
        newStatus[alert.id] = { status: 'passed', reviewedAt: new Date().toISOString() }
      }
    })
    setReviewStatus(newStatus)
    setSelectedAlerts(function (prev) {
      var next = new Set(prev)
      serviceAlerts.forEach(function (alert) { next.delete(alert.id) })
      return next
    })
  }

  function changePreviewZoom(delta) {
    setPreviewZoom(function (value) {
      return Math.max(40, Math.min(130, value + delta))
    })
  }

  async function handleExport() {
    if (!selectedProjectId || selectedAlerts.size === 0) return

    setExportLoading(true)
    try {
      var payload = buildFilteredResultJson(allAlerts, selectedAlerts)
      downloadJsonFile('review-result-' + selectedProjectId + '.json', payload)

      setNotice({ type: 'success', message: '过滤后的 JSON 已导出' })
      setShowExport(false)
    } catch (e) {
      setNotice({ type: 'error', message: '导出失败: ' + (e.message || '未知错误') })
    } finally {
      setExportLoading(false)
    }
  }

  var resultTypeKeys = []
  allAlerts.forEach(function (alert) {
    if (resultTypeKeys.indexOf(alert.resultType) < 0) {
      resultTypeKeys.push(alert.resultType)
    }
  })
  var resultTypeCounts = {}
  allAlerts.forEach(function (alert) {
    resultTypeCounts[alert.resultType] = (resultTypeCounts[alert.resultType] || 0) + 1
  })

  var reviewedCount = allAlerts.filter(function (alert) { return reviewStatus[alert.id] }).length
  var totalCount = allAlerts.length
  var progressPercent = totalCount > 0 ? Math.round((reviewedCount / totalCount) * 100) : 0

  var sidebarKeys = resultTypeKeys

  var selectedByType = {}
  selectedAlerts.forEach(function (id) {
    var alert = allAlerts.find(function (a) { return a.id === id })
    if (alert) {
      var rt = alert.resultTypeLabel
      selectedByType[rt] = (selectedByType[rt] || 0) + 1
    }
  })

  // Build PDF panels for current alert
  var pdfDocIds = currentAlert ? getAlertDocIds(currentAlert) : []

  return (
    <>
      {notice ? (
        <div className={'notice notice-' + notice.type}>
          <p>{notice.message}</p>
          <button
            type="button"
            className="text-button"
            onClick={function () { setNotice(null) }}
          >
            ✕
          </button>
        </div>
      ) : null}

      <section className="review-header">
        <div className="review-header-left">
          <h2>结果审核</h2>
          <ProjectDropdown
            projects={projects}
            selectedProjectId={selectedProjectId}
            onChange={handleProjectChange}
          />
        </div>

        <div className="review-header-right">
          {totalCount > 0 ? (
            <div className="review-progress">
              <div className="review-progress-bar">
                <div
                  className="review-progress-fill"
                  style={{ width: progressPercent + '%' }}
                />
              </div>
              <span>{progressPercent}% 已审核</span>
            </div>
          ) : null}

          {selectedAlerts.size > 0 ? (
            <span className="toolbar-selected-count">已保留 {selectedAlerts.size} 项</span>
          ) : null}

          <button
            type="button"
            className="primary-button"
            onClick={function () { setShowExport(!showExport) }}
            disabled={!selectedProjectId || selectedAlerts.size === 0}
          >
            导出报告{selectedAlerts.size > 0 ? ' (' + selectedAlerts.size + ')' : ''}
          </button>
        </div>
      </section>

      {selectedProjectId ? (
        <main className="review-layout">
          <aside className="panel review-sidebar">
            <div className="panel-header">
              <h3>结果筛选</h3>
            </div>

            {currentServiceType ? (
              <div className="select-all-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={serviceAlerts.length > 0 && serviceAlerts.every(function (a) { return selectedAlerts.has(a.id) })}
                    onChange={toggleSelectAllCurrent}
                  />
                  <span>保留当前全部</span>
                </label>
              </div>
            ) : null}

            <div className="filter-card-list">
              {sidebarKeys.map(function (key) {
                var isActive = currentServiceType === key
                var count = resultTypeCounts[key] || 0
                var color = RESULT_TYPE_COLORS[key] || '#64748b'

                return (
                  <button
                    key={key}
                    type="button"
                    className={'filter-card' + (isActive ? ' filter-card-active' : '')}
                    style={isActive ? { borderColor: color, background: color + '10' } : {}}
                    onClick={function () { selectServiceType(key) }}
                  >
                    <span
                      className="filter-card-dot"
                      style={{ background: isActive ? color : '#cbd5e1' }}
                    />
                    <span className="filter-card-label">{RESULT_TYPE_LABELS[key] || key}</span>
                    <span
                      className="filter-card-count"
                      style={isActive ? { background: color, color: '#fff' } : {}}
                    >
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="review-actions">
              <button type="button" className="ghost-button" onClick={batchPassAll} disabled={!currentServiceType || serviceAlerts.length === 0}>
                一键忽略当前
              </button>
            </div>
          </aside>

          <section className="review-main">
            {isLoading ? (
              <EmptyBlock title="加载中..." />
            ) : !currentServiceType ? (
              <EmptyBlock title={results ? '请从左侧选择一个服务类型' : '暂无分析结果'} />
            ) : serviceAlerts.length === 0 ? (
              <EmptyBlock title="该类型下未发现可疑项" />
            ) : currentAlert ? (
              <div className="detail-container">
                {/* ── Navigation bar ── */}
                <div className="detail-nav">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={currentAlertIndex === 0}
                    onClick={goToPrev}
                  >
                    ◀ 上一条
                  </button>
                  <span className="detail-nav-info">
                    第 {currentAlertIndex + 1}/{serviceAlerts.length} 条
                  </span>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={currentAlertIndex >= serviceAlerts.length - 1}
                    onClick={goToNext}
                  >
                    下一条 ▶
                  </button>
                </div>

                {/* ── Alert info ── */}
                <div className="panel detail-info">
                  <div className="detail-info-head">
                    <span className={'risk-tag ' + (RISK_CLASSES[currentAlert.riskLevel] || 'risk-none')}>
                      {RISK_LABELS[currentAlert.riskLevel] || currentAlert.riskLevel}
                    </span>
                    <span className="alert-tag">{currentAlert.resultTypeLabel}</span>
                    <span className="alert-tag">{currentAlert.groupLabel}</span>
                    {reviewStatus[currentAlert.id] ? (
                      <span className={'review-badge ' + (reviewStatus[currentAlert.id].status === 'passed' ? 'badge-passed' : 'badge-flagged')}>
                        {reviewStatus[currentAlert.id].status === 'passed' ? '已忽略' : '已保留'}
                      </span>
                    ) : null}
                  </div>

                  <strong className="alert-title">{currentAlert.title}</strong>
                  <p>{currentAlert.description}</p>

                  {currentAlert.metrics ? (
                    <div className="alert-metrics">
                      {Object.entries(currentAlert.metrics).map(function (entry) {
                        var key = entry[0]
                        var value = entry[1]
                        return (
                          <span key={key}>
                            {key}: {typeof value === 'number' ? value.toFixed ? value.toFixed(2) : value : value}
                          </span>
                        )
                      })}
                    </div>
                  ) : null}
                </div>

                {/* ── PDF preview row ── */}
                {pdfDocIds.length > 0 ? (
                  <div className="detail-pdf-section">
                    <div className="detail-pdf-summary">
                      <span>关联文件</span>
                      {pdfDocIds.map(function (docInfo) {
                        var docKey = docInfo.docKey || docInfo.docId || docInfo.fileName || docInfo.label
                        var preview = previewData[docKey]
                        var page = previewPages[docKey] || getPreviewStartPage(docInfo, currentAlert)
                        var pageCount = getPreviewPageCount(preview, docInfo)

                        return (
                          <span className="detail-pdf-chip" key={'chip-' + docKey}>
                            {docInfo.label || '文档'}：第 {page}{pageCount ? ' / ' + pageCount : ''} 页
                          </span>
                        )
                      })}
                    </div>

                    <div className="detail-pdf-row">
                      {previewLoading ? (
                        <div className="panel detail-pdf-panel detail-pdf-loading">
                          <EmptyBlock title="加载预览..." />
                        </div>
                      ) : (
                        pdfDocIds.map(function (docInfo) {
                          var docKey = docInfo.docKey || docInfo.docId || docInfo.fileName || docInfo.label
                          var preview = previewData[docKey]
                          var currentPage = previewPages[docKey] || getPreviewStartPage(docInfo, currentAlert)
                          var pageCount = getPreviewPageCount(preview, docInfo)
                          var isBusy = Boolean(previewBusy[docKey])
                          var errorMessage = previewErrors[docKey]
                          var pageInputValue = previewPageInputs[docKey] === undefined ? String(currentPage) : previewPageInputs[docKey]

                          return (
                            <div className="panel detail-pdf-panel" key={docKey}>
                              <div className="detail-pdf-head">
                                <div className="detail-pdf-title-group">
                                  <strong className="detail-pdf-name">{docInfo.label}</strong>
                                  <span className="detail-pdf-page-badge">
                                    定位第 {currentPage}{pageCount ? ' / ' + pageCount : ''} 页
                                  </span>
                                </div>
                                <div className="preview-toolbox">
                                  <button
                                    type="button"
                                    className="preview-download-btn"
                                    onClick={function () { handleDownloadPdf(docInfo) }}
                                  >
                                    下载 PDF
                                  </button>
                                  <form
                                    className="preview-page-jump"
                                    onSubmit={function (event) {
                                      event.preventDefault()
                                      handleDocPageJump(docInfo)
                                    }}
                                  >
                                    <span>跳到</span>
                                    <input
                                      type="text"
                                      inputMode="numeric"
                                      value={pageInputValue}
                                      disabled={isBusy}
                                      onChange={function (event) { handlePageInputChange(docInfo, event.target.value) }}
                                    />
                                    <span>页</span>
                                    <button type="submit" disabled={isBusy || !pageInputValue}>
                                      跳转
                                    </button>
                                  </form>
                                  <div className="preview-zoom-control" aria-label="预览缩放">
                                    <button
                                      type="button"
                                      className="preview-zoom-btn"
                                      disabled={previewZoom <= 40}
                                      onClick={function () { changePreviewZoom(-10) }}
                                    >
                                      -
                                    </button>
                                    <span>{previewZoom}%</span>
                                    <button
                                      type="button"
                                      className="preview-zoom-btn"
                                      disabled={previewZoom >= 130}
                                      onClick={function () { changePreviewZoom(10) }}
                                    >
                                      +
                                    </button>
                                  </div>
                                </div>
                              </div>
                              <div
                                className="diff-page-preview"
                                style={{ '--preview-zoom': previewZoom / 100 }}
                              >
                                {preview && preview.image_data_url ? (
                                  <button
                                    type="button"
                                    className="preview-image-button"
                                    onClick={function () {
                                      setPreviewLightbox({
                                        image: preview.image_data_url,
                                        label: docInfo.label,
                                        page: currentPage,
                                        pageCount: pageCount,
                                      })
                                    }}
                                    title="点击放大预览"
                                  >
                                    <img
                                      src={preview.image_data_url}
                                      alt={docInfo.label}
                                      className="diff-image"
                                    />
                                  </button>
                                ) : null}
                                {preview && !preview.image_data_url ? (
                                  <p>第 {preview.page || currentPage} 页，共 {preview.page_count || pageCount || '--'} 页</p>
                                ) : null}
                                {isBusy ? (
                                  <div className="preview-loading-overlay">
                                    正在加载第 {currentPage} 页...
                                  </div>
                                ) : null}
                                {!preview && !isBusy && errorMessage ? (
                                  <p className="preview-error">{errorMessage}</p>
                                ) : null}
                                {!preview && !isBusy && !errorMessage ? (
                                  <p>无预览</p>
                                ) : null}
                              </div>
                              {errorMessage && preview ? (
                                <p className="preview-error">{errorMessage}</p>
                              ) : null}
                              <div className="pdf-page-nav">
                                <button
                                  type="button"
                                  className="pdf-page-btn"
                                  disabled={currentPage <= 1 || isBusy}
                                  onClick={function () { handleDocPageChange(docInfo, -1) }}
                                >
                                  ◀ 上一页
                                </button>
                                <span className="pdf-page-info">
                                  第 {currentPage}{pageCount ? ' / ' + pageCount : ''} 页
                                </span>
                                <button
                                  type="button"
                                  className="pdf-page-btn"
                                  disabled={isBusy || Boolean(pageCount && currentPage >= pageCount)}
                                  onClick={function () { handleDocPageChange(docInfo, 1) }}
                                >
                                  下一页 ▶
                                </button>
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  </div>
                ) : null}

                {/* ── Text evidence ── */}
                {currentAlert.evidence ? (
                  <div className="panel detail-text-block">
                    <strong>检测文字</strong>

                    {/* Duplicate blocks */}
                    {(currentAlert.evidence.duplicateBlocks || []).map(function (block, i) {
                      return (
                        <div key={'dup-' + i} className="diff-block">
                          <span className="diff-block-page">
                            第 {(block.left_page || block.page)} 页（左）/ 第 {(block.right_page || '--')} 页（右）
                          </span>
                          <p>{block.text || block.left_text}</p>
                        </div>
                      )
                    })}

                    {/* Similar blocks */}
                    {(currentAlert.evidence.similarBlocks || []).map(function (block, i) {
                      return (
                        <div key={'sim-' + i} className="diff-block diff-block-similar">
                          <span className="diff-block-page">
                            相似: L{block.left_page} / R{block.right_page}
                          </span>
                          <p>L: {block.left_text}</p>
                          <p>R: {block.right_text}</p>
                        </div>
                      )
                    })}

                    {/* Typo evidence */}
                    {currentAlert.evidence.matchedText ? (
                      <div className="diff-block">
                        <span className="diff-block-page">
                          第 {currentAlert.evidence.page} 页
                        </span>
                        <p>
                          检测到: <strong>{currentAlert.evidence.matchedText}</strong>
                          {currentAlert.evidence.suggestion ? ' → ' + currentAlert.evidence.suggestion : ''}
                        </p>
                      </div>
                    ) : null}

                    {/* Format review issue */}
                    {currentAlert.evidence.issue ? (
                      <div className="diff-block">
                        <span className="diff-block-page">
                          {currentAlert.page ? '第 ' + currentAlert.page + ' 页' : '形式审查'}
                        </span>
                        <p>{currentAlert.evidence.issue.message || currentAlert.evidence.reviewSummary}</p>
                      </div>
                    ) : null}

                    {/* Personnel documents list */}
                    {(currentAlert.evidence.documents || []).length > 0 && !currentAlert.evidence.matchedText && !currentAlert.evidence.duplicateBlocks ? (
                      (currentAlert.evidence.documents || []).map(function (doc, i) {
                        return (
                          <div key={'pdoc-' + i} className="diff-block">
                            <span className="diff-block-page">文档 {i + 1}</span>
                            <p>{doc.file_name}</p>
                          </div>
                        )
                      })
                    ) : null}
                  </div>
                ) : null}

                {/* ── Actions ── */}
                <div className="panel detail-actions">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedAlerts.has(currentAlert.id)}
                      onChange={function () { toggleAlertSelection(currentAlert.id) }}
                    />
                    <span>保留导出</span>
                  </label>

                  <div className="detail-review-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={function () { handleReview(currentAlert.id, 'passed') }}
                      disabled={reviewStatus[currentAlert.id] && reviewStatus[currentAlert.id].status === 'passed'}
                    >
                      忽略此项
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={function () { handleReview(currentAlert.id, 'flagged') }}
                      disabled={reviewStatus[currentAlert.id] && reviewStatus[currentAlert.id].status === 'flagged'}
                    >
                      确认保留
                    </button>
                  </div>
                </div>

                {/* ── Notes ── */}
                <div className="panel detail-notes">
                  {reviewStatus[currentAlert.id] && reviewStatus[currentAlert.id].note ? (
                    <p className="review-note">备注: {reviewStatus[currentAlert.id].note}</p>
                  ) : null}
                  <input
                    className="review-note-input"
                    placeholder="添加备注..."
                    value={reviewNotes[currentAlert.id] || ''}
                    onChange={function (event) { handleNote(currentAlert.id, event.target.value) }}
                    onBlur={function () {
                      var note = reviewNotes[currentAlert.id] || ''
                      if (note.trim()) {
                        setReviewStatus(function (prev) {
                          var next = {}
                          for (var k in prev) { next[k] = prev[k] }
                          next[currentAlert.id] = Object.assign({}, prev[currentAlert.id], { note: note.trim() })
                          return next
                        })
                      }
                    }}
                  />
                </div>
              </div>
            ) : null}
          </section>
        </main>
      ) : (
        <section className="panel empty-panel">
          <EmptyBlock title="请先选择一个项目" />
        </section>
      )}

      {showExport ? (
        <div
          className="modal-overlay"
          onClick={function () { setShowExport(false) }}
          ref={exportModalRef}
        >
          <div
            className="modal-panel"
            onClick={function (event) { event.stopPropagation() }}
          >
            <div className="modal-header">
              <h3>导出过滤结果</h3>
              <button
                type="button"
                className="text-button"
                onClick={function () { setShowExport(false) }}
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              <div className="export-summary">
                <div className="export-summary-item">
                  <span className="export-summary-label">保留项</span>
                  <span className="export-summary-value">{selectedAlerts.size} 项</span>
                </div>
                {Object.keys(selectedByType).length > 0 ? (
                  <div className="export-summary-types">
                    {Object.entries(selectedByType).map(function (entry) {
                      return (
                        <span key={entry[0]} className="export-type-tag">
                          {entry[0]} × {entry[1]}
                        </span>
                      )
                    })}
                  </div>
                ) : null}
              </div>

              <div className="export-section">
                <strong>导出说明</strong>
                <p>将导出业务员确认保留的审查结果，文件结构为 result 数组，不包含已忽略项。</p>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="ghost-button"
                onClick={function () { setShowExport(false) }}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={exportLoading}
                onClick={handleExport}
              >
                {exportLoading ? '导出中...' : '导出 JSON'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {previewLightbox ? (
        <div
          className="preview-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="放大预览"
          onClick={function () { setPreviewLightbox(null) }}
        >
          <div
            className="preview-lightbox-card"
            onClick={function (event) { event.stopPropagation() }}
          >
            <div className="preview-lightbox-head">
              <div>
                <strong>{previewLightbox.label}</strong>
                <span>
                  第 {previewLightbox.page}{previewLightbox.pageCount ? ' / ' + previewLightbox.pageCount : ''} 页
                </span>
              </div>
              <button
                type="button"
                className="preview-lightbox-close"
                onClick={function () { setPreviewLightbox(null) }}
              >
                关闭
              </button>
            </div>
            <img
              src={previewLightbox.image}
              alt={previewLightbox.label}
              className="preview-lightbox-image"
            />
          </div>
        </div>
      ) : null}
    </>
  )
}
