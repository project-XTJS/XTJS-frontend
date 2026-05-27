import { useCallback, useEffect, useState, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  getDocumentSourceUrl,
  getDocumentPreview,
  getProjectDetail,
  getProjectResults,
  listProjects,
  updateResultForFrontend,
} from '../lib/xtjsApi'
import { DOCUMENT_LABELS } from '../utils/formatters'
import { normalizeProjectResultsPayload } from '../utils/results'
import EmptyBlock from '../components/EmptyBlock'
import ProjectDropdown from '../components/ProjectDropdown'

var RESULT_TYPE_LABELS = {
  duplicate_check: '全文查重',
  business_bid_duplicate_check: '商务标查重',
  technical_bid_duplicate_check: '技术标查重',
  business_bid_format_review: '形式审查',
  personnel_reuse_check: '人员复用',
  typo_check: '错字检查',
}

var RESULT_TYPE_COLORS = {
  duplicate_check: '#dc2626',
  business_bid_duplicate_check: '#ea580c',
  technical_bid_duplicate_check: '#f59e0b',
  business_bid_format_review: '#2563eb',
  personnel_reuse_check: '#9333ea',
  typo_check: '#0891b2',
}

var OVERVIEW_RESULT_ORDER = [
  'business_bid_duplicate_check',
  'technical_bid_duplicate_check',
  'business_bid_format_review',
  'typo_check',
  'personnel_reuse_check',
]

var FORMAT_CHECK_LABELS = {
  pricing_check: '报价校验',
  deviation_check: '偏离响应校验',
  integrity_check: '完整性校验',
  consistency_check: '格式一致性校验',
  verification_check: '签章日期校验',
  itemized_pricing_check: '分项报价校验',
}

var FORMAT_OVERVIEW_CHECK_ORDER = [
  'integrity_check',
  'consistency_check',
  'pricing_check',
  'itemized_pricing_check',
  'deviation_check',
  'verification_check',
]

var FORMAT_OVERVIEW_CHECK_LABELS = {
  integrity_check: '完整性',
  consistency_check: '一致性',
  pricing_check: '开标一览表',
  itemized_pricing_check: '分项报价表',
  deviation_check: '偏离表',
  verification_check: '签字盖章日期检查',
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function arrayify(value) {
  return Array.isArray(value) ? value : []
}

function appendUnique(list, value, limit) {
  var text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return
  if (list.indexOf(text) >= 0) return
  list.push(text.length > 240 ? text.slice(0, 240) : text)
  if (limit && list.length > limit) {
    list.length = limit
  }
}

function collectHighlightPhrases() {
  var phrases = []

  Array.from(arguments).forEach(function collect(value) {
    if (phrases.length >= 12) return
    if (Array.isArray(value)) {
      value.forEach(collect)
      return
    }
    if (isObject(value)) {
      collect(value.highlight)
      collect(value.highlightPhrases)
      collect(value.matched_text)
      collect(value.matchedText)
      collect(value.name)
      collect(value.role)
      collect(value.text)
      collect(value.message)
      return
    }
    appendUnique(phrases, value, 12)
  })

  return phrases
}

function hasRectShape(value) {
  return Array.isArray(value) &&
    value.length >= 4 &&
    value.slice(0, 4).every(function (item) { return typeof item === 'number' && Number.isFinite(item) })
}

function bboxToRect(value, format) {
  if (!hasRectShape(value)) return null

  var x0 = Number(value[0])
  var y0 = Number(value[1])
  var third = Number(value[2])
  var fourth = Number(value[3])

  if (format === 'xywh' || third <= x0 || fourth <= y0) {
    var width = Math.max(third, 0)
    var height = Math.max(fourth, 0)
    if (width <= 0 || height <= 0) return null
    return [x0, y0, x0 + width, y0 + height]
  }

  return [x0, y0, third, fourth]
}

function collectHighlightRects(value, format) {
  var rects = []

  function collect(valueToCollect) {
    if (!valueToCollect) return
    if (hasRectShape(valueToCollect)) {
      var rect = bboxToRect(valueToCollect, format)
      if (rect) rects.push(rect)
      return
    }
    if (Array.isArray(valueToCollect)) {
      valueToCollect.forEach(collect)
    }
  }

  collect(value)
  return rects.slice(0, 24)
}

function makeHighlightPageRects(page, rects) {
  var pageNumber = getFirstNumber(page)
  if (!pageNumber) return []

  return collectHighlightRects(rects).map(function (rect) {
    return { page: pageNumber, rect: rect }
  })
}

function collectHighlightPageRects(value, targetPage) {
  var target = getFirstNumber(targetPage)
  var rects = []

  function collect(valueToCollect, inheritedPage) {
    if (!valueToCollect) return
    if (hasRectShape(valueToCollect)) {
      if (!target || !inheritedPage || Number(inheritedPage) === Number(target)) {
        var rect = bboxToRect(valueToCollect)
        if (rect) rects.push(rect)
      }
      return
    }
    if (Array.isArray(valueToCollect)) {
      valueToCollect.forEach(function (item) { collect(item, inheritedPage) })
      return
    }
    if (isObject(valueToCollect)) {
      var page = getFirstNumber(valueToCollect.page) ||
        getFirstNumber(valueToCollect.page_no) ||
        getFirstNumber(valueToCollect.page_number) ||
        getFirstNumber(valueToCollect.startPage) ||
        inheritedPage
      collect(valueToCollect.rect, page)
      collect(valueToCollect.bbox, page)
      collect(valueToCollect.highlightBbox, page)
      collect(valueToCollect.rects, page)
      collect(valueToCollect.highlightRects, page)
    }
  }

  collect(value)
  return rects.slice(0, 24)
}

function mergeHighlightPageRects(left, right) {
  return arrayify(left).concat(arrayify(right)).slice(0, 120)
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

function getGroupLabel(groupKey, defaultGroupKey) {
  return DOCUMENT_LABELS[groupKey] || DOCUMENT_LABELS[defaultGroupKey] || groupKey || defaultGroupKey || ''
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

function normalizeDocRef(raw, defaults) {
  var source = raw || {}
  var base = defaults || {}
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
    docKey: source.docKey || base.docKey || docId || fileName || label,
    label: label,
    startPage: page,
    pageCount: source.page_count || source.pageCount || base.pageCount,
    role: source.role || base.role,
    purpose: source.purpose || base.purpose,
    documentType: source.document_type || source.documentType || base.documentType,
    highlight: source.highlight || source.highlightPhrases || base.highlight,
    highlightBbox: source.highlightBbox || source.bbox || base.highlightBbox,
    highlightRects: source.highlightRects || source.highlight_rects || base.highlightRects,
    highlightPageRects: source.highlightPageRects || source.highlight_page_rects || base.highlightPageRects,
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
      overviewDocuments: arrayify(alert.overviewDocuments).map(function (doc) {
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

function isDuplicateIssueVisible(item) {
  var riskLevel = String(item.risk_level || '').toLowerCase()
  return Boolean(item) && riskLevel !== '' && riskLevel !== 'none'
}

function getDuplicateClusterFileUrl(cluster, fileName) {
  return cluster.file_urls_by_file && cluster.file_urls_by_file[fileName]
}

function compactCompareText(value) {
  if (Array.isArray(value)) {
    return value.map(compactCompareText).join('')
  }
  if (isObject(value)) {
    return compactCompareText(
      value.text ||
      value.preview ||
      value.title ||
      value.message ||
      value.name ||
      '',
    )
  }
  return String(value || '')
    .toLowerCase()
    .replace(/[｜|"'“”‘’[\]{}()（）:：,，.。;；、\s]/g, '')
}

function collectDuplicateNeedles(cluster, fileName) {
  var previews = cluster.doc_previews_by_file && cluster.doc_previews_by_file[fileName]
  var weighted = []

  function add(value, weight) {
    var values = Array.isArray(value) ? value : [value]
    values.forEach(function (item) {
      var text = compactCompareText(item)
      if (text.length < 6) return
      if (weighted.some(function (entry) { return entry.text === text })) return
      weighted.push({ text: text, weight: weight })
    })
  }

  add(cluster.title, 90)
  add(previews, 70)
  add(cluster.tokens, 50)

  return weighted
}

function scoreDuplicateLocation(cluster, fileName, location) {
  var target = compactCompareText(location)
  if (target.length < 4) return locationBboxToRect(location) ? 1 : 0

  var score = 0
  collectDuplicateNeedles(cluster, fileName).forEach(function (needle) {
    if (target.indexOf(needle.text) >= 0 || needle.text.indexOf(target) >= 0) {
      score += needle.weight
      return
    }

    var probeLength = Math.min(24, needle.text.length, target.length)
    if (probeLength >= 8) {
      var targetProbe = target.slice(0, probeLength)
      var needleProbe = needle.text.slice(0, probeLength)
      if (target.indexOf(needleProbe) >= 0 || needle.text.indexOf(targetProbe) >= 0) {
        score += Math.floor(needle.weight / 2)
      }
    }
  })

  if (locationBboxToRect(location)) score += 5
  return score
}

function getDuplicateClusterRangeStarts(cluster, fileName) {
  var ranges = cluster.doc_ranges_by_file && cluster.doc_ranges_by_file[fileName]
  var pages = []

  arrayify(ranges).forEach(function (range) {
    var page = extractFirstPage(range && (range.start_page || range.startPage || range.page || range.pages))
    if (!page && Array.isArray(range)) page = getFirstNumber(range[0])
    if (page && pages.indexOf(page) < 0) pages.push(page)
  })

  return pages.sort(function (a, b) { return Number(a) - Number(b) })
}

function chooseDuplicateClusterPage(cluster, group) {
  var scored = group.locations.map(function (location) {
    return {
      location: location,
      page: extractFirstPage(location),
      score: scoreDuplicateLocation(cluster, group.fileName, location),
      hasRect: Boolean(locationBboxToRect(location)),
    }
  }).filter(function (entry) {
    return entry.page
  })

  var bestScore = Math.max.apply(null, scored.map(function (entry) { return entry.score }).concat([0]))
  if (bestScore > 0) {
    var bestEntries = scored.filter(function (entry) {
      return entry.score === bestScore
    })
    bestEntries.sort(function (a, b) {
      if (a.hasRect !== b.hasRect) return a.hasRect ? -1 : 1
      return Number(a.page) - Number(b.page)
    })
    return bestEntries[0] && bestEntries[0].page
  }

  var rangeStarts = getDuplicateClusterRangeStarts(cluster, group.fileName)
  if (rangeStarts.length > 0) return rangeStarts[0]
  return group.firstPage
}

function getDuplicateClusterPageLocations(cluster, group, page) {
  var locations = group.locations.filter(function (location) {
    return Number(extractFirstPage(location)) === Number(page)
  })
  var matching = locations.filter(function (location) {
    return scoreDuplicateLocation(cluster, group.fileName, location) > 0
  })
  return matching.length > 0 ? matching : locations
}

function getDuplicateClusterFileGroups(cluster) {
  var groups = {}

  function ensureGroup(fileName) {
    if (!fileName) return null
    var rangeStart = getDuplicateClusterRangeStarts(cluster, fileName)[0] || null
    if (!groups[fileName]) {
      groups[fileName] = {
        fileName: fileName,
        firstPage: rangeStart,
        hasRangePage: Boolean(rangeStart),
        locations: [],
      }
    } else if (!groups[fileName].hasRangePage && rangeStart) {
      groups[fileName].firstPage = rangeStart
      groups[fileName].hasRangePage = true
    }
    return groups[fileName]
  }

  arrayify(cluster.files).forEach(function (fileName) {
    ensureGroup(fileName)
  })

  Object.keys(cluster.doc_ranges_by_file || {}).forEach(function (fileName) {
    ensureGroup(fileName)
  })

  arrayify(cluster.locations).forEach(function (location) {
    var fileName = location && location.file_name
    var page = extractFirstPage(location)
    if (!fileName || !page) return

    var group = ensureGroup(fileName)
    group.locations.push(location)
    if (!group.hasRangePage && (!group.firstPage || Number(page) < Number(group.firstPage))) {
      groups[fileName].firstPage = page
    }
  })

  return Object.values(groups).filter(function (group) {
    return group.locations.length > 0 || group.firstPage
  }).sort(function (a, b) {
    return Number(a.firstPage || 1) - Number(b.firstPage || 1)
  })
}

function buildDuplicateClusterDocs(cluster) {
  return getDuplicateClusterFileGroups(cluster).map(function (group, index) {
    var fileName = group.fileName
    var page = chooseDuplicateClusterPage(cluster, group) || group.firstPage || 1
    var locations = getDuplicateClusterPageLocations(cluster, group, page)
    var rects = locations.map(locationBboxToRect).filter(Boolean)
    var locationWithId = locations.find(function (location) {
      return location.document_identifier_id || location.identifier_id
    }) || group.locations.find(function (location) {
      return location.document_identifier_id || location.identifier_id
    })
    var docId = locationWithId && (locationWithId.document_identifier_id || locationWithId.identifier_id)
    var previews = cluster.doc_previews_by_file && cluster.doc_previews_by_file[fileName]

    return normalizeDocRef({
      identifier_id: docId,
      file_name: fileName,
      file_url: getDuplicateClusterFileUrl(cluster, fileName),
      page: page,
      docKey: (docId || fileName || 'duplicate-cluster-doc') + '#cluster-' + index + '-' + page,
      highlight: collectHighlightPhrases(cluster.tokens, cluster.title, previews, locations),
      highlightBbox: rects[0],
      highlightRects: rects,
      highlightPageRects: makeHighlightPageRects(page, rects),
    }, { label: fileName, page: page })
  }).filter(Boolean)
}

function collectDuplicateAlerts(results, allAlerts) {
  var duplicateKeys = []
  if (results.business_bid_duplicate_check) duplicateKeys.push('business_bid_duplicate_check')
  if (results.technical_bid_duplicate_check) duplicateKeys.push('technical_bid_duplicate_check')

  duplicateKeys.forEach(function (resultKey) {
    var result = results[resultKey]
    if (!result) return

    arrayify(result.issues).forEach(function (item, index) {
      if (!isDuplicateIssueVisible(item)) return

      var docs = buildDuplicateClusterDocs(item)
      var score = item.score_display || item.score_value
      var groupKey = item.document_type || result.document_type

      var alert = {
        id: makeAlertId('duplicate', resultKey, groupKey, item.cluster_id, index),
        resultType: resultKey,
        sourceResultKey: resultKey,
        resultTypeLabel: RESULT_TYPE_LABELS[resultKey] || RESULT_TYPE_LABELS.duplicate_check,
        groupKey: groupKey,
        groupLabel: getGroupLabel(groupKey, item.document_type),
        riskLevel: normalizeRiskLevel(item.risk_level),
        title: item.title,
        description: '匹配得分 ' + (score === undefined || score === null ? '--' : score),
        metrics: {
          '完全重复块': item.metrics && item.metrics.exact_block_count,
          '相似块': item.metrics && item.metrics.similar_block_count,
          '重复表格': item.metrics && item.metrics.exact_table_count,
        },
        evidence: {
          cluster: item,
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
        var highlightRects = collectHighlightRects(item.bbox, 'xywh')
        var docRef = normalizeDocRef({
          document_identifier_id: item.document_identifier_id || doc.identifier_id,
          file_name: fileName,
          file_url: item.file_url || item.file_path || doc.file_url || doc.file_path,
          page: page,
          highlight: collectHighlightPhrases(item.matched_text, item.issue_key),
          highlightBbox: highlightRects[0],
          highlightRects: highlightRects,
          highlightPageRects: makeHighlightPageRects(page, highlightRects),
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

function getPersonnelIssueItems(check) {
  return arrayify(check.items)
}

function getPersonnelEvidenceDocs(item) {
  return arrayify(item.occurrences)
}

function buildPersonnelDocRef(doc, personName, index) {
  if (!isObject(doc)) return null

  var page = extractFirstPage(doc) || 1
  var role = doc.role || doc.person_role || doc.position
  var rects = collectHighlightRects(doc.highlightRects)
    .concat(collectHighlightRects(doc.highlight_rects))
    .concat(collectHighlightRects(doc.bbox, 'xywh'))
    .concat(collectHighlightRects(doc.box, 'xywh'))
  var docKeyBase = doc.document_identifier_id ||
    doc.identifier_id ||
    doc.doc_id ||
    doc.docId ||
    doc.file_name ||
    doc.fileName ||
    doc.document_name ||
    ('personnel-doc-' + index)

  return normalizeDocRef(Object.assign({}, doc, {
    docKey: docKeyBase + '#p' + page,
    page: page,
    highlight: collectHighlightPhrases(
      doc.highlight,
      doc.highlightPhrases,
      doc.matched_text,
      doc.matchedText,
      doc.name || personName,
      role,
    ),
    highlightBbox: rects[0],
    highlightRects: rects,
    highlightPageRects: makeHighlightPageRects(page, rects),
  }), { page: page })
}

function mergePreviewDocsByKey(docs) {
  var merged = {}
  var order = []

  arrayify(docs).forEach(function (doc) {
    if (!doc) return
    var key = doc.docKey || doc.docId || doc.fileName || doc.label
    if (!key) return
    if (!merged[key]) {
      merged[key] = doc
      order.push(key)
      return
    }

    var existing = merged[key]
    var existingRects = collectHighlightRects(existing.highlightRects)
    var nextRects = collectHighlightRects(doc.highlightRects)
    merged[key] = compactObject(Object.assign({}, existing, {
      startPage: Math.min(existing.startPage || doc.startPage || 1, doc.startPage || existing.startPage || 1),
      highlight: collectHighlightPhrases(existing.highlight, doc.highlight),
      highlightBbox: existing.highlightBbox || doc.highlightBbox,
      highlightRects: existingRects.concat(nextRects).slice(0, 24),
      highlightPageRects: mergeHighlightPageRects(existing.highlightPageRects, doc.highlightPageRects),
    }))
  })

  return order.map(function (key) { return merged[key] })
}

function getPreviewDocIdentityAliases(doc) {
  if (!doc) return []

  return uniqueValues([
    doc.fileUrl,
    doc.file_url,
    doc.filePath,
    doc.file_path,
    doc.sourceRef,
    doc.docId,
    doc.document_identifier_id,
    doc.identifier_id,
    doc.doc_id,
    doc.fileName,
    doc.file_name,
    doc.document_name,
  ])
}

function getPreviewDocDisplayKey(doc, fallbackKey) {
  return doc.docId ||
    doc.document_identifier_id ||
    doc.identifier_id ||
    doc.fileName ||
    doc.file_name ||
    doc.fileUrl ||
    doc.file_url ||
    doc.sourceRef ||
    fallbackKey ||
    doc.docKey ||
    doc.label
}

function mergePreviewDocsByFile(docs) {
  var merged = {}
  var order = []
  var aliasLookup = {}

  function findGroupKey(aliases) {
    for (var i = 0; i < aliases.length; i++) {
      var aliasKey = getLookupKey(aliases[i])
      if (aliasKey && aliasLookup[aliasKey]) return aliasLookup[aliasKey]
    }
    return ''
  }

  function registerAliases(groupKey, aliases) {
    aliases.forEach(function (alias) {
      var aliasKey = getLookupKey(alias)
      if (aliasKey) aliasLookup[aliasKey] = groupKey
    })
  }

  arrayify(docs).forEach(function (doc) {
    if (!doc) return

    var aliases = getPreviewDocIdentityAliases(doc)
    var groupKey = findGroupKey(aliases)
    if (!groupKey) {
      var primary = aliases[0] || doc.docKey || doc.label
      if (!primary) return
      groupKey = 'doc:' + getLookupKey(primary)
      merged[groupKey] = compactObject(Object.assign({}, doc, {
        docKey: getPreviewDocDisplayKey(doc, primary),
        targetPages: [],
      }))
      order.push(groupKey)
    }

    registerAliases(groupKey, aliases)

    var existing = merged[groupKey]
    var pages = arrayify(existing.targetPages).slice()
    addUniquePage(pages, existing.startPage)
    addUniquePage(pages, doc.startPage)
    pages.sort(function (a, b) { return Number(a) - Number(b) })

    var existingRects = collectHighlightRects(existing.highlightRects)
    var nextRects = collectHighlightRects(doc.highlightRects)
    merged[groupKey] = compactObject(Object.assign({}, existing, {
      docId: existing.docId || doc.docId,
      fileName: existing.fileName || doc.fileName,
      fileUrl: existing.fileUrl || doc.fileUrl,
      sourceRef: existing.sourceRef || doc.sourceRef,
      label: existing.label || doc.label,
      startPage: pages[0] || existing.startPage || doc.startPage || 1,
      targetPages: pages,
      pageCount: existing.pageCount || doc.pageCount,
      role: existing.role || doc.role,
      purpose: existing.purpose || doc.purpose,
      documentType: existing.documentType || doc.documentType,
      highlight: collectHighlightPhrases(existing.highlight, doc.highlight),
      highlightBbox: existing.highlightBbox || doc.highlightBbox,
      highlightRects: existingRects.concat(nextRects).slice(0, 24),
      highlightPageRects: mergeHighlightPageRects(existing.highlightPageRects, doc.highlightPageRects),
    }))
  })

  return order.map(function (key) { return merged[key] })
}

function isTenderTemplateDoc(doc) {
  if (!doc) return false
  var role = String(doc.role || '').toLowerCase()
  var purpose = String(doc.purpose || '').toLowerCase()
  var documentType = String(doc.documentType || doc.document_type || '').toLowerCase()
  return role === 'tender' ||
    documentType === 'tender' ||
    purpose.indexOf('template') >= 0 ||
    purpose.indexOf('requirement') >= 0
}

function isBusinessBidDoc(doc) {
  if (!doc) return false
  var role = String(doc.role || '').toLowerCase()
  var purpose = String(doc.purpose || '').toLowerCase()
  var documentType = String(doc.documentType || doc.document_type || '').toLowerCase()
  return role === 'business' ||
    role === 'business_bid' ||
    documentType === 'business' ||
    documentType === 'business_bid' ||
    purpose.indexOf('business') >= 0 ||
    purpose.indexOf('recognized_business') >= 0
}

function docsReferToSameFile(a, b) {
  var leftAliases = getPreviewDocIdentityAliases(a).map(getLookupKey).filter(Boolean)
  var rightAliases = getPreviewDocIdentityAliases(b).map(getLookupKey).filter(Boolean)
  if (leftAliases.length === 0 || rightAliases.length === 0) return false
  return leftAliases.some(function (alias) {
    return rightAliases.indexOf(alias) >= 0
  })
}

function getBidderBusinessDocumentCandidate(bidder) {
  var docs = bidder && bidder.documents
  if (isObject(docs)) {
    var direct = docs.business || docs.business_bid || docs.bidder || docs.bid
    if (direct) return Object.assign({ role: 'business_bid', document_type: 'business_bid' }, direct)
  }

  return documentCandidatesFromValue(docs).find(function (doc) {
    return isBusinessBidDoc(doc)
  }) || null
}

function buildFormatOverviewDocuments(bidder, documentLookup, docRefs, previewPage) {
  var businessDoc = getBidderBusinessDocumentCandidate(bidder)
  var mergedBusinessDoc = businessDoc ? mergeDocumentCandidate(businessDoc, documentLookup || {}) : null
  var overviewDoc = normalizeDocRef(mergedBusinessDoc, {
    page: previewPage || 1,
    role: 'business_bid',
    documentType: 'business_bid',
  })

  if (!overviewDoc) return []

  var matchingRefs = arrayify(docRefs).filter(function (doc) {
    return docsReferToSameFile(doc, overviewDoc)
  })
  var refs = matchingRefs.length > 0 ? matchingRefs : [overviewDoc]

  return refs.map(function (doc) {
    return compactObject(Object.assign({}, doc, {
      docId: overviewDoc.docId || doc.docId,
      fileName: overviewDoc.fileName || doc.fileName,
      fileUrl: overviewDoc.fileUrl || doc.fileUrl,
      label: overviewDoc.label || doc.label || overviewDoc.fileName,
      role: doc.role || overviewDoc.role || 'business_bid',
      documentType: doc.documentType || overviewDoc.documentType || 'business_bid',
      startPage: doc.startPage || overviewDoc.startPage || previewPage || 1,
    }))
  })
}

function getFormatMissingAnchors(issue) {
  return collectHighlightPhrases(
    issue && issue.evidence && issue.evidence.missing_anchors,
  )
}

var FORMAT_TENDER_LOCATION_FIELDS = [
  'template_locations',
  'tender_price_locations',
  'tender_star_locations',
  'deadline_locations',
]

var FORMAT_BID_LOCATION_FIELDS = [
  'response_locations',
  'matched_locations',
  'catalog_locations',
]

var FORMAT_TENDER_HIGHLIGHT_CONFIG = {
  integrity_check: {
    docKeyPrefix: 'integrity-template',
    defaultLabel: '招标文件模板',
    labelSuffix: '（缺失内容位置）',
  },
  consistency_check: {
    docKeyPrefix: 'consistency-template',
    defaultLabel: '招标文件模板',
    labelSuffix: '（缺失内容位置）',
  },
  pricing_check: {
    docKeyPrefix: 'pricing-tender',
    defaultLabel: '招标文件',
    labelSuffix: '（最高限价/预算位置）',
  },
  itemized_pricing_check: {
    docKeyPrefix: 'itemized-pricing-tender',
    defaultLabel: '招标文件',
    labelSuffix: '（分项报价要求位置）',
  },
  deviation_check: {
    docKeyPrefix: 'deviation-tender-star',
    defaultLabel: '招标文件',
    labelSuffix: '（★条款位置）',
  },
  verification_check: {
    docKeyPrefix: 'verification-tender',
    defaultLabel: '招标文件',
    labelSuffix: '（签字盖章日期要求位置）',
  },
}

function uniqueLocationCandidates(locations) {
  var seen = {}
  return arrayify(locations).filter(function (location) {
    if (!location) return false
    var key = JSON.stringify({
      id: location.document_identifier_id || location.identifier_id || '',
      file: location.file_name || '',
      role: getLocationDocumentRole(location),
      page: extractFirstPage(location),
      text: location.text || location.label || '',
      bbox: location.bbox || null,
    })
    if (seen[key]) return false
    seen[key] = true
    return true
  })
}

function collectFormatEvidenceLocations(issue) {
  var evidence = (issue && issue.evidence) || {}
  var locations = []

  arrayify(evidence.locations).forEach(function (location) {
    locations.push(location)
  })

  FORMAT_BID_LOCATION_FIELDS.forEach(function (field) {
    arrayify(evidence[field]).forEach(function (location) {
      locations.push(withLocationDocumentRole(location, 'business_bid'))
    })
  })

  FORMAT_TENDER_LOCATION_FIELDS.forEach(function (field) {
    arrayify(evidence[field]).forEach(function (location) {
      locations.push(withLocationDocumentRole(location, 'tender'))
    })
  })

  Object.entries(evidence).forEach(function (entry) {
    var field = entry[0]
    if (!/_locations$/.test(field)) return
    if (field === 'locations' ||
      FORMAT_BID_LOCATION_FIELDS.indexOf(field) >= 0 ||
      FORMAT_TENDER_LOCATION_FIELDS.indexOf(field) >= 0) {
      return
    }

    arrayify(entry[1]).forEach(function (location) {
      var role = getLocationDocumentRole(location)
      if (role) locations.push(location)
    })
  })

  return uniqueLocationCandidates(locations)
}

function getTenderRoleLocationCandidates(values) {
  var locations = []
  arrayify(values).forEach(function (value) {
    arrayify(value).forEach(function (location) {
      if (getLocationDocumentRole(location) === 'tender') locations.push(location)
    })
  })
  return uniqueLocationCandidates(locations)
}

function getFormatTenderHighlightConfig(checkKey) {
  return FORMAT_TENDER_HIGHLIGHT_CONFIG[checkKey] || {
    docKeyPrefix: 'format-tender',
    defaultLabel: '招标文件',
    labelSuffix: '（对应位置）',
  }
}

function getFormatTenderHighlightLocations(issue) {
  return uniqueLocationCandidates(
    getTenderRoleLocationCandidates([
      collectFormatEvidenceLocations(issue),
      issue && issue.locations,
    ]),
  )
}

function getFormatTenderHighlightPhrases(issue, checkKey) {
  if (checkKey === 'consistency_check') {
    return getFormatMissingAnchors(issue)
  }
  return collectHighlightPhrases(issue && issue.title, issue && issue.message)
}

function locationBboxToRect(location) {
  if (!location) return null
  var raw = location.bbox
  var coordinateSystem = String(location.coordinate_system || '').toLowerCase()
  var format = coordinateSystem.indexOf('xywh') >= 0 || coordinateSystem.indexOf('ocr') >= 0
    ? 'xywh'
    : undefined
  return bboxToRect(raw, format)
}

function getLocationDocumentRole(location) {
  var raw = String(
    (location && (
      location.document_role ||
      location.document ||
      location.role ||
      location.document_type
    )) || ''
  ).toLowerCase()

  if (raw.indexOf('tender') >= 0) return 'tender'
  if (raw.indexOf('technical') >= 0) return 'technical_bid'
  if (raw.indexOf('business') >= 0 || raw.indexOf('bidder') >= 0) return 'business_bid'
  return ''
}

function withLocationDocumentRole(location, role) {
  if (!location || getLocationDocumentRole(location)) return location
  return Object.assign({}, location, { document_role: role })
}

function collectFormatLocationValues(issue, checkKey) {
  var evidenceLocations = collectFormatEvidenceLocations(issue)
  var issueLocations = arrayify(issue && issue.locations)

  var evidenceHasDocumentHint = evidenceLocations.some(function (location) {
    return Boolean(
      location && (
        location.document_identifier_id ||
        location.identifier_id ||
        location.file_name ||
        getLocationDocumentRole(location)
      )
    )
  })

  var ordered = []
  if (checkKey === 'pricing_check' && evidenceHasDocumentHint) {
    ordered = evidenceLocations.concat(issueLocations)
  } else {
    ordered = issueLocations.concat(evidenceLocations)
  }

  return uniqueLocationCandidates(ordered).filter(function (location) {
    return Boolean(location && extractFirstPage(location))
  })
}

function getFormatBidFallbackPage(issue, fallbackPage) {
  var evidence = (issue && issue.evidence) || {}
  return getFirstNumber(issue && issue.response_page) ||
    getFirstNumber(evidence.response_page) ||
    extractFirstPage(arrayify(evidence.response_locations)[0]) ||
    extractFirstPage(arrayify(evidence.matched_locations)[0]) ||
    fallbackPage ||
    1
}

function resolveRoleDocFromLookup(role, lookup) {
  if (!role || !lookup) return null
  if (role === 'tender') return lookup['role:tender'] || lookup['type:tender']
  if (role === 'technical_bid') {
    return lookup['role:technical'] || lookup['role:technical_bid'] ||
      lookup['type:technical'] || lookup['type:technical_bid']
  }
  if (role === 'business_bid') {
    return lookup['role:business'] || lookup['role:business_bid'] ||
      lookup['role:bidder'] || lookup['type:business'] || lookup['type:business_bid']
  }
  return null
}

function locationMatchesDoc(location, doc) {
  if (!location || !doc) return false
  var locationId = getLookupKey(location.document_identifier_id || location.identifier_id || location.docId)
  var docId = getLookupKey(doc.document_identifier_id || doc.identifier_id || doc.docId)
  if (locationId && docId && locationId === docId) return true

  var locationFile = getLookupKey(location.file_name || location.fileName)
  var docFile = getLookupKey(doc.file_name || doc.fileName)
  if (locationFile && docFile && locationFile === docFile) return true

  var role = getLocationDocumentRole(location)
  if (!role) return false
  if (role === 'tender') return isTenderTemplateDoc(doc)
  if (role === 'business_bid') return isBusinessBidDoc(doc)
  return false
}

function getPageForDocFromLocations(doc, locations) {
  var match = arrayify(locations).find(function (location) {
    return locationMatchesDoc(location, doc)
  })
  return extractFirstPage(match)
}

function buildTenderLocationDocRefs(locations, options) {
  var opts = options || {}
  var groups = {}

  arrayify(locations).forEach(function (location) {
    var page = extractFirstPage(location)
    var resolvedDoc = mergeDocumentCandidate(location || {}, opts.documentLookup || {})
    if ((!resolvedDoc || (!resolvedDoc.docId && !resolvedDoc.identifier_id && !resolvedDoc.fileName && !resolvedDoc.file_name)) && getLocationDocumentRole(location) === 'tender') {
      resolvedDoc = resolveRoleDocFromLookup('tender', opts.documentLookup || {})
    }
    var docId = location && (location.document_identifier_id || location.identifier_id)
    var fileName = location && location.file_name
    if (!docId) docId = resolvedDoc && (resolvedDoc.docId || resolvedDoc.identifier_id || resolvedDoc.document_identifier_id)
    if (!fileName) fileName = resolvedDoc && (resolvedDoc.fileName || resolvedDoc.file_name)
    if (!page || (!docId && !fileName)) return

    var key = [docId || '', fileName || '', page].join('|')
    if (!groups[key]) {
      groups[key] = {
        location: location,
        resolvedDoc: resolvedDoc,
        page: page,
        highlights: [],
        rects: [],
      }
    }

    collectHighlightPhrases(location.text, opts.highlights).forEach(function (phrase) {
      appendUnique(groups[key].highlights, phrase, 12)
    })

    var rect = locationBboxToRect(location)
    if (rect) groups[key].rects.push(rect)
  })

  return Object.values(groups).sort(function (a, b) {
    return Number(a.page) - Number(b.page)
  }).map(function (entry, index) {
    var location = entry.location
    var resolvedDoc = entry.resolvedDoc || {}
    return normalizeDocRef({
      document_identifier_id: location.document_identifier_id || location.identifier_id || resolvedDoc.docId || resolvedDoc.identifier_id,
      file_name: location.file_name || resolvedDoc.fileName || resolvedDoc.file_name,
      file_url: location.file_url || resolvedDoc.fileUrl || resolvedDoc.file_url,
      document_type: 'tender',
      role: 'tender',
      page: entry.page,
      docKey: (location.document_identifier_id || location.identifier_id || location.file_name || resolvedDoc.docId || resolvedDoc.fileName || opts.docKeyPrefix || 'tender-location') +
        '#' + (opts.docKeyPrefix || 'tender-location') + '-' + index + '-' + entry.page,
      label: (location.file_name || resolvedDoc.fileName || resolvedDoc.file_name || opts.defaultLabel || '招标文件') + (opts.labelSuffix || ''),
      highlight: entry.highlights,
      highlightBbox: entry.rects[0],
      highlightRects: entry.rects,
      highlightPageRects: makeHighlightPageRects(entry.page, entry.rects),
    }, { page: entry.page })
  }).filter(Boolean)
}

function buildFormatTenderHighlightDocRefs(issue, checkKey, options) {
  var opts = options || {}
  var config = getFormatTenderHighlightConfig(checkKey)
  return buildTenderLocationDocRefs(getFormatTenderHighlightLocations(issue), {
    documentLookup: opts.documentLookup,
    docKeyPrefix: config.docKeyPrefix,
    defaultLabel: config.defaultLabel,
    labelSuffix: config.labelSuffix,
    highlights: getFormatTenderHighlightPhrases(issue, checkKey),
  })
}

function buildIssueLocationDocRefs(issue, options) {
  var opts = options || {}
  var groups = {}

  arrayify(opts.locations || (issue && issue.locations)).forEach(function (location) {
    var page = extractFirstPage(location)
    var role = getLocationDocumentRole(location)
    var resolvedDoc = mergeDocumentCandidate(location || {}, opts.documentLookup || {})
    if ((!resolvedDoc || (!resolvedDoc.docId && !resolvedDoc.identifier_id && !resolvedDoc.fileName && !resolvedDoc.file_name)) && role) {
      resolvedDoc = resolveRoleDocFromLookup(role, opts.documentLookup || {})
    }
    var docId = location && (location.document_identifier_id || location.identifier_id)
    var fileName = location && location.file_name
    if (!docId) docId = resolvedDoc && (resolvedDoc.docId || resolvedDoc.identifier_id || resolvedDoc.document_identifier_id)
    if (!fileName) fileName = resolvedDoc && (resolvedDoc.fileName || resolvedDoc.file_name)
    if (!page || (!docId && !fileName)) return

    var key = [docId || '', fileName || '', page].join('|')
    if (!groups[key]) {
      groups[key] = {
        location: location,
        resolvedDoc: resolvedDoc,
        role: role,
        page: page,
        highlights: [],
        rects: [],
      }
    }

    collectHighlightPhrases(location.text, issue.title, issue.message, opts.highlights).forEach(function (phrase) {
      appendUnique(groups[key].highlights, phrase, 12)
    })

    var rect = locationBboxToRect(location)
    if (rect) groups[key].rects.push(rect)
  })

  var sortedEntries = Object.values(groups).sort(function (a, b) {
    return Number(a.page) - Number(b.page)
  })
  var tenderEntries = sortedEntries.filter(function (entry) {
    return entry.role === 'tender' || getLocationDocumentRole(entry.location) === 'tender'
  })
  var otherEntries = sortedEntries.filter(function (entry) {
    return !(entry.role === 'tender' || getLocationDocumentRole(entry.location) === 'tender')
  })

  return tenderEntries.concat(otherEntries.slice(0, 4)).map(function (entry, index) {
    var location = entry.location
    var resolvedDoc = entry.resolvedDoc || {}
    return normalizeDocRef({
      document_identifier_id: location.document_identifier_id || location.identifier_id || resolvedDoc.docId || resolvedDoc.identifier_id,
      file_name: location.file_name || resolvedDoc.fileName || resolvedDoc.file_name,
      file_url: location.file_url || resolvedDoc.fileUrl || resolvedDoc.file_url,
      document_type: location.document_type || opts.documentType,
      role: location.role || location.document_role || entry.role || opts.role,
      page: entry.page,
      docKey: (location.document_identifier_id || location.identifier_id || location.file_name || resolvedDoc.docId || resolvedDoc.fileName || opts.docKeyPrefix || 'issue-location') +
        '#' + (opts.docKeyPrefix || 'issue-location') + '-' + index + '-' + entry.page,
      label: location.file_name || resolvedDoc.fileName || resolvedDoc.file_name || opts.defaultLabel || '定位文档',
      highlight: entry.highlights,
      highlightBbox: entry.rects[0],
      highlightRects: entry.rects,
      highlightPageRects: makeHighlightPageRects(entry.page, entry.rects),
    }, { page: entry.page })
  }).filter(Boolean)
}

function getIssueAttachmentRefs(issue) {
  var refs = []
  var title = String((issue && issue.title) || '')

  title.replace(/附件\s*\d+(?:\s*[-－]\s*\d+)*/g, function (match) {
    appendUnique(refs, match)
    return match
  })

  return refs
}

function addUniquePage(pages, value) {
  var page = getFirstNumber(value) || extractFirstPage(value)
  if (!page) return
  if (pages.indexOf(page) < 0) pages.push(page)
}

function addPagesFromValue(pages, value) {
  if (Array.isArray(value)) {
    value.forEach(function (item) {
      addUniquePage(pages, item)
    })
    return
  }
  addUniquePage(pages, value)
}

function getIntegrityCatalogLocations(issue) {
  var evidence = (issue && issue.evidence) || {}

  return arrayify(evidence.catalog_locations)
}

function getIntegrityCatalogPages(issue) {
  var evidence = (issue && issue.evidence) || {}
  var pages = []

  getIntegrityCatalogLocations(issue).forEach(function (location) {
    addUniquePage(pages, location)
  })

  addPagesFromValue(pages, evidence.catalog_pages)

  return pages
}

function getIntegrityTemplateLocations(issue) {
  return getFormatTenderHighlightLocations(issue)
}

function buildPageDocRefs(baseDoc, options) {
  var pages = options.pages
  var locations = options.locations || []
  var highlights = options.highlights || []

  return pages.map(function (page, pageIndex) {
    var pageLocations = locations.filter(function (location) {
      return Number(extractFirstPage(location)) === Number(page)
    })
    var rects = pageLocations.map(locationBboxToRect).filter(Boolean)

    return compactObject(Object.assign({}, baseDoc, {
      docKey: (baseDoc.docKey || baseDoc.docId || baseDoc.fileName || baseDoc.label || options.keyPrefix) +
        '#' + options.keyPrefix + '-' + pageIndex + '-' + page,
      startPage: page,
      label: (baseDoc.label || baseDoc.fileName) + options.labelSuffix,
      highlight: highlights,
      highlightBbox: rects[0] || baseDoc.highlightBbox,
      highlightRects: rects.length > 0 ? rects : undefined,
      highlightPageRects: rects.length > 0 ? makeHighlightPageRects(page, rects) : baseDoc.highlightPageRects,
    }))
  })
}

function buildIntegrityMissingDocRefs(issue, docRefs) {
  var status = String((issue && issue.status) || '').toLowerCase()
  if (status && status !== 'missing') return []

  var businessDocs = arrayify(docRefs).filter(isBusinessBidDoc)
  var tenderDocs = arrayify(docRefs).filter(isTenderTemplateDoc)
  if (businessDocs.length === 0 || tenderDocs.length === 0) return []

  var attachmentRefs = getIssueAttachmentRefs(issue)
  var highlights = collectHighlightPhrases(issue && issue.title, attachmentRefs)
  var catalogLocations = getIntegrityCatalogLocations(issue)
  var catalogPages = getIntegrityCatalogPages(issue)
  var templateLocations = getIntegrityTemplateLocations(issue)
  var templatePages = []

  templateLocations.forEach(function (location) {
    addUniquePage(templatePages, location)
  })

  var businessRefs = buildPageDocRefs(businessDocs[0], {
    pages: catalogPages,
    locations: catalogLocations,
    highlights: collectHighlightPhrases('目录', highlights),
    keyPrefix: 'integrity-catalog',
    labelSuffix: '（投标文件目录页）',
  })
  var tenderRefs = buildPageDocRefs(tenderDocs[0], {
    pages: templatePages,
    locations: templateLocations,
    highlights: highlights,
    keyPrefix: 'integrity-template',
    labelSuffix: '（招标文件模板附件页）',
  })

  return businessRefs.concat(tenderRefs)
}

function orderFormatReviewDocRefs(docRefs) {
  var docs = arrayify(docRefs)
  var businessDocs = docs.filter(isBusinessBidDoc)
  var tenderDocs = docs.filter(isTenderTemplateDoc)
  var otherDocs = docs.filter(function (doc) {
    return !isBusinessBidDoc(doc) && !isTenderTemplateDoc(doc)
  })

  return tenderDocs.concat(businessDocs, otherDocs)
}

function collectPersonnelAlertsFromGroups(resultKey, result, allAlerts, options) {
  if (!result || !result.groups) return
  var opts = options || {}

  Object.entries(result.groups).forEach(function (entry) {
    var groupKey = entry[0]
    var groupValue = entry[1] || {}
    var check = groupValue.personnel_reuse_check || {}
    var items = getPersonnelIssueItems(check)

    items.forEach(function (item, index) {
      var name = item.name || item.person_name || item.personnel_name || '疑似复用人员'
      var evidenceDocs = getPersonnelEvidenceDocs(item)
      var docs = mergePreviewDocsByKey(evidenceDocs.map(function (doc, docIndex) {
        return buildPersonnelDocRef(doc, name, docIndex)
      }).filter(Boolean))
      var uniqueDocuments = uniqueValues(docs.map(function (doc) {
        return doc.docId || doc.fileName || doc.label
      }))
      var documentCount = item.document_count || uniqueDocuments.length || docs.length || item.occurrence_count || 0
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
          items: item.occurrences,
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
      var missingIssues = arrayify(check.issues && check.issues.missing)
      var unclearIssues = arrayify(check.issues && check.issues.unclear)
      var issues = failedIssues.concat(missingIssues, unclearIssues)
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
        var formatLocations = collectFormatLocationValues(issue, checkKey)
        var page = extractFirstPage(issue) ||
          extractFirstPage(issue.evidence) ||
          extractFirstPage(check.raw_result) ||
          extractPageFromText(issue.message || (check.review && check.review.summary))
        var sourceDocs = arrayify(check.source_context && check.source_context.source_documents)
        if (sourceDocs.length === 0) sourceDocs = documentCandidatesFromValue(bidder.documents)
        if (!sourceDocs.some(isBusinessBidDoc)) {
          var businessDocCandidate = getBidderBusinessDocumentCandidate(bidder)
          if (businessDocCandidate) sourceDocs = sourceDocs.concat([businessDocCandidate])
        }
        sourceDocs = sourceDocs.map(function (doc) {
          return mergeDocumentCandidate(doc, bidderDocumentLookup)
        })
        var bidFallbackPage = getFormatBidFallbackPage(issue, page)
        var docRefs = sourceDocs.map(function (doc, docIndex) {
          var sourceDocPage = extractFirstPage(doc)
          var locationPage = getPageForDocFromLocations(doc, formatLocations)
          var sourceDocIsTender = isTenderTemplateDoc(doc)
          var defaultPage = locationPage || sourceDocPage
          if (!defaultPage && !sourceDocIsTender) {
            defaultPage = bidFallbackPage
          }
          if (!defaultPage) return null
          return normalizeDocRef(doc, {
            fileName: doc.file_name || bidder.file_name,
            page: defaultPage,
            label: doc.file_name || doc.role || bidder.bidder_name || ('关联文档 ' + (docIndex + 1)),
            role: sourceDocIsTender ? 'tender' : 'business_bid',
            documentType: sourceDocIsTender ? 'tender' : 'business_bid',
          })
        }).filter(Boolean)
        var formatTenderRefs = buildFormatTenderHighlightDocRefs(issue, checkKey, {
          documentLookup: bidderDocumentLookup,
        })
        if (checkKey === 'integrity_check') {
          var integrityMissingRefs = buildIntegrityMissingDocRefs(issue, docRefs)
          if (integrityMissingRefs.length > 0) {
            docRefs = integrityMissingRefs
          } else if (formatTenderRefs.length > 0) {
            docRefs = formatTenderRefs.concat(docRefs.filter(function (doc) {
              return !isTenderTemplateDoc(doc)
            }))
          }
        } else if (formatTenderRefs.length > 0) {
          docRefs = formatTenderRefs.concat(docRefs.filter(function (doc) {
            return !isTenderTemplateDoc(doc)
          }))
        }
        docRefs = orderFormatReviewDocRefs(docRefs)
        var issueLocationRefs = buildIssueLocationDocRefs(issue, {
          locations: formatLocations,
          documentLookup: bidderDocumentLookup,
          docKeyPrefix: 'format-issue',
          defaultLabel: bidder.bidder_name || bidder.file_name || '定位文档',
        })
        if (issueLocationRefs.length > 0) {
          var issueLocationKeys = {}
          issueLocationRefs.forEach(function (doc) {
            issueLocationKeys[(doc.docId || '') + '|' + (doc.fileName || '') + '|' + doc.startPage] = true
          })
          docRefs = issueLocationRefs.concat(docRefs.filter(function (doc) {
            return !issueLocationKeys[(doc.docId || '') + '|' + (doc.fileName || '') + '|' + doc.startPage]
          }))
        }
        docRefs = orderFormatReviewDocRefs(docRefs)
        var docRef = docRefs.find(function (doc) {
          return doc.role === 'business' || doc.purpose === 'business_bid_source' || doc.purpose === 'quoted_price_source'
        }) || docRefs[0]
        var previewPage = docRefs[0] && docRefs[0].startPage ? docRefs[0].startPage : page
        var checkLabel = check.check_name || FORMAT_CHECK_LABELS[checkKey] || checkKey
        var riskLevel = normalizeRiskLevel(issue.severity || issue.status || reviewStatus)
        var overviewDocuments = buildFormatOverviewDocuments(bidder, bidderDocumentLookup, docRefs, previewPage)

        var alert = {
          id: makeAlertId('format', bidder.bidder_key || bidder.bidder_name || bidderIndex, checkKey, issue.title, issueIndex),
          resultType: 'business_bid_format_review',
          sourceResultKey: 'business_bid_format_review',
          subType: checkKey,
          formatOverviewOrder: getFormatOverviewCheckOrder(checkKey),
          formatOverviewLabel: FORMAT_OVERVIEW_CHECK_LABELS[checkKey] || checkLabel,
          resultTypeLabel: RESULT_TYPE_LABELS.business_bid_format_review,
          bidderKey: bidder.bidder_key,
          bidderName: bidder.bidder_name,
          groupKey: 'business_bid',
          groupLabel: DOCUMENT_LABELS.business_bid,
          riskLevel: riskLevel === 'none' ? 'medium' : riskLevel,
          title: checkLabel + '：' + (issue.title || '需人工复核'),
          description: (bidder.bidder_name || bidder.bidder_key || '投标人') + ' - ' + (issue.message || (check.review && check.review.summary) || '发现需复核项'),
          metrics: {
            '投标人': bidder.bidder_name || bidder.bidder_key || '--',
            '审查项': checkLabel,
            '页码': previewPage || '--',
          },
          evidence: {
            issue: issue,
            reviewSummary: check.review && check.review.summary,
            documents: sourceDocs,
            templateMissingAnchors: checkKey === 'consistency_check' ? getFormatMissingAnchors(issue) : undefined,
            tenderHighlightLocations: getFormatTenderHighlightLocations(issue),
          },
          documents: docRefs,
          overviewDocuments: overviewDocuments,
          page: previewPage,
          sourceItem: issue,
        }

        alert.exportPayload = compactObject({
          result_key: 'business_bid_format_review',
          bidder_key: bidder.bidder_key,
          bidder_name: bidder.bidder_name,
          check_code: check.check_code || checkKey,
          check_name: checkLabel,
          file_name: docRef && docRef.fileName,
          page: previewPage,
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

var PREVIEW_HIGHLIGHTS_ENABLED = true

// Extract document list from an alert for PDF preview rendering
function getAlertDocIds(alert) {
  if (alert && alert.documents && alert.documents.length > 0) {
    return mergePreviewDocsByFile(orderFormatReviewDocRefs(alert.documents))
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
    return mergePreviewDocsByFile(docs)
  }

  // Single document (typo, review-typo)
  if (alert.documentId) {
    docs.push({
      docId: alert.documentId,
      docKey: alert.documentId,
      label: alert.title || '文档',
      startPage: (alert.evidence && alert.evidence.page) || 1,
    })
    return mergePreviewDocsByFile(docs)
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

  return mergePreviewDocsByFile(docs)
}

function formatHighlightBbox(bbox) {
  return Array.isArray(bbox) ? bbox.join(',') : bbox
}

function shouldHighlightPreviewDoc(docInfo) {
  return PREVIEW_HIGHLIGHTS_ENABLED && isTenderTemplateDoc(docInfo)
}

function getPreviewOptions(docInfo, page) {
  if (!shouldHighlightPreviewDoc(docInfo)) return {}

  var hasPageRects = arrayify(docInfo.highlightPageRects).length > 0
  var highlightRects = hasPageRects
    ? collectHighlightPageRects(docInfo.highlightPageRects, page)
    : collectHighlightRects(docInfo.highlightRects)
  var highlightBbox = highlightRects[0] || (hasPageRects ? null : bboxToRect(docInfo.highlightBbox))

  return {
    highlight: collectHighlightPhrases(docInfo.highlight),
    highlightBbox: formatHighlightBbox(highlightBbox),
    highlightRects: highlightRects.length > 0 ? highlightRects : undefined,
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

function getAlertProblemDocs(alert) {
  var docs = getAlertDocIds(alert)
  var issueDocs = docs.filter(function (doc) {
    return !isTenderTemplateDoc(doc)
  })

  return issueDocs.length > 0 ? issueDocs : docs
}

function getDocSortFileKey(doc) {
  return getLookupKey(getPreviewDocIdentityAliases(doc)[0] || (doc && doc.label))
}

function getAlertDisplaySortInfo(alert) {
  var docs = getAlertProblemDocs(alert)
  var primaryDoc = docs[0] || null
  var pages = []

  docs.forEach(function (doc) {
    addPagesFromValue(pages, doc && doc.targetPages)
    addUniquePage(pages, doc && doc.startPage)
    addUniquePage(pages, doc && doc.page)
  })
  if (pages.length === 0) {
    addUniquePage(pages, alert && alert.page)
    addUniquePage(pages, alert && alert.evidence && alert.evidence.page)
  }
  pages.sort(function (a, b) { return Number(a) - Number(b) })

  return {
    fileKey: getDocSortFileKey(primaryDoc),
    page: pages[0] || null,
  }
}

function compareOptionalNumber(a, b) {
  if (a && b) return Number(a) - Number(b)
  if (a) return -1
  if (b) return 1
  return 0
}

function sortAlertsForDisplay(alerts) {
  return arrayify(alerts).map(function (alert, index) {
    return {
      alert: alert,
      index: index,
      sortInfo: getAlertDisplaySortInfo(alert),
    }
  }).sort(function (a, b) {
    if (a.sortInfo.fileKey && b.sortInfo.fileKey && a.sortInfo.fileKey !== b.sortInfo.fileKey) {
      return a.sortInfo.fileKey.localeCompare(b.sortInfo.fileKey)
    }
    if (a.sortInfo.fileKey && !b.sortInfo.fileKey) return -1
    if (!a.sortInfo.fileKey && b.sortInfo.fileKey) return 1

    var pageOrder = compareOptionalNumber(a.sortInfo.page, b.sortInfo.page)
    if (pageOrder !== 0) return pageOrder
    return a.index - b.index
  }).map(function (entry) {
    return entry.alert
  })
}

function getResultTypeOrderIndex(resultType, resultTypeOrder) {
  var order = arrayify(resultTypeOrder).length > 0 ? resultTypeOrder : OVERVIEW_RESULT_ORDER
  var index = order.indexOf(resultType)
  return index >= 0 ? index : order.length
}

function compareAlertsForExport(a, b, resultTypeOrder) {
  var typeOrder = getResultTypeOrderIndex(a.resultType, resultTypeOrder) -
    getResultTypeOrderIndex(b.resultType, resultTypeOrder)
  if (typeOrder !== 0) return typeOrder

  var aInfo = getAlertDisplaySortInfo(a)
  var bInfo = getAlertDisplaySortInfo(b)
  if (aInfo.fileKey && bInfo.fileKey && aInfo.fileKey !== bInfo.fileKey) {
    return aInfo.fileKey.localeCompare(bInfo.fileKey)
  }
  if (aInfo.fileKey && !bInfo.fileKey) return -1
  if (!aInfo.fileKey && bInfo.fileKey) return 1

  var pageOrder = compareOptionalNumber(aInfo.page, bInfo.page)
  if (pageOrder !== 0) return pageOrder

  return String(a.id || '').localeCompare(String(b.id || ''))
}

function sortAlertsForExport(alerts, resultTypeOrder) {
  return arrayify(alerts).slice().sort(function (a, b) {
    return compareAlertsForExport(a, b, resultTypeOrder)
  })
}

function formatPreviewPageLabel(docInfo, currentPage, pageCount) {
  var pages = []
  arrayify(docInfo && docInfo.targetPages).forEach(function (page) {
    addUniquePage(pages, page)
  })
  if (pages.length === 0) addUniquePage(pages, currentPage)
  pages.sort(function (a, b) { return Number(a) - Number(b) })

  var visiblePages = pages.slice(0, 5).join('、') + (pages.length > 5 ? '…' : '')
  return '第 ' + visiblePages + (pageCount ? ' / ' + pageCount : '') + ' 页'
}

function getPreviewCurrentPage(preview, defaultPage) {
  return (preview && preview.page) || defaultPage || 1
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
      return await getDocumentPreview(targets[i], page, getPreviewOptions(docInfo, page))
    } catch (error) {
      lastError = error
    }
  }

  throw lastError || new Error('无法加载预览')
}

function buildFilteredResultJson(alerts, selectedAlertIds, resultTypeOrder) {
  var selected = sortAlertsForExport(alerts.filter(function (alert) {
    return selectedAlertIds.has(alert.id)
  }), resultTypeOrder)

  return {
    result: selected.map(function (alert) {
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

function getReportDownloadUrl(response) {
  return response?.report_upload?.presigned_url ||
    response?.report_upload?.file_url ||
    response?.report_url ||
    ''
}

function getProjectIdentifierValue(project) {
  return project && (project.identifier_id || project.identifierId || project.id || project.project_name || project.projectName)
}

function getProjectTitle(projectDetail, project, fallback) {
  var detailProject = projectDetail && projectDetail.project
  return (detailProject && (detailProject.project_name || detailProject.projectName || detailProject.identifier_id)) ||
    (project && (project.project_name || project.projectName || project.title || project.identifierId)) ||
    fallback ||
    '当前项目'
}

function getProjectOverviewFiles(projectDetail) {
  var files = []

  function addFile(name, type) {
    var text = String(name || '').trim()
    if (!text || files.some(function (item) { return item.name === text })) return
    files.push({ name: text, type: type })
  }

  arrayify(projectDetail && projectDetail.relations).forEach(function (relation) {
    addFile(relation.tender_file_name, '招标文件')
    addFile(relation.business_bid_file_name, '商务标')
    addFile(relation.technical_bid_file_name, '技术标')
  })

  return files
}

function getOverviewResultKeys(results, resultTypeKeys) {
  var keys = []

  OVERVIEW_RESULT_ORDER.forEach(function (key) {
    if ((results && results[key]) || resultTypeKeys.indexOf(key) >= 0) {
      keys.push(key)
    }
  })
  resultTypeKeys.forEach(function (key) {
    if (keys.indexOf(key) < 0) keys.push(key)
  })

  return keys
}

function countAlertsByRisk(alerts, riskLevel) {
  return arrayify(alerts).filter(function (alert) {
    return alert.riskLevel === riskLevel
  }).length
}

function formatMetricValue(value) {
  if (value === undefined || value === null || value === '') return '--'
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
  }
  return String(value)
}

function getAlertMetricSummary(alert) {
  var entries = Object.entries((alert && alert.metrics) || {}).filter(function (entry) {
    return entry[1] !== undefined && entry[1] !== null && entry[1] !== ''
  })

  if (entries.length === 0) return '--'
  return entries.slice(0, 3).map(function (entry) {
    return entry[0] + ': ' + formatMetricValue(entry[1])
  }).join('；')
}

function formatOverviewPageList(doc) {
  var pages = []
  addPagesFromValue(pages, doc && doc.targetPages)
  addUniquePage(pages, doc && doc.startPage)
  addUniquePage(pages, doc && doc.page)
  pages.sort(function (a, b) { return Number(a) - Number(b) })

  if (pages.length === 0) return '页码待补充'
  return pages.slice(0, 5).map(function (page) {
    return 'P' + page
  }).join('、') + (pages.length > 5 ? '…' : '')
}

function getOverviewAlertDocs(alert) {
  if (alert && alert.resultType === 'business_bid_format_review' && arrayify(alert.overviewDocuments).length > 0) {
    return mergePreviewDocsByFile(alert.overviewDocuments).slice(0, 3)
  }

  var docs = getAlertDocIds(alert)
  var problemDocs = getAlertProblemDocs(alert)
  return (problemDocs.length > 0 ? problemDocs : docs).slice(0, 3)
}

function getFormatOverviewCheckOrder(checkKey) {
  var index = FORMAT_OVERVIEW_CHECK_ORDER.indexOf(checkKey)
  return index >= 0 ? index : FORMAT_OVERVIEW_CHECK_ORDER.length
}

function getFormatOverviewAlertDocs(alert) {
  var docs = arrayify(alert && alert.overviewDocuments)
  if (docs.length > 0) return mergePreviewDocsByFile(docs)
  return getOverviewAlertDocs(alert)
}

function getFormatOverviewFileKey(alert) {
  var doc = getFormatOverviewAlertDocs(alert)[0]
  return getLookupKey(
    (doc && (doc.docId || doc.fileName || doc.label)) ||
    (alert && (alert.bidderKey || alert.bidderName || alert.id))
  )
}

function getFormatOverviewFileLabel(alert) {
  var doc = getFormatOverviewAlertDocs(alert)[0]
  return (doc && (doc.label || doc.fileName || doc.docId)) ||
    (alert && (alert.bidderName || alert.bidderKey)) ||
    '未关联文件'
}

function getFormatOverviewSortInfo(alert) {
  var docs = getFormatOverviewAlertDocs(alert)
  var pages = []
  docs.forEach(function (doc) {
    addPagesFromValue(pages, doc && doc.targetPages)
    addUniquePage(pages, doc && doc.startPage)
    addUniquePage(pages, doc && doc.page)
  })
  if (pages.length === 0) addUniquePage(pages, alert && alert.page)
  pages.sort(function (a, b) { return Number(a) - Number(b) })

  return {
    fileKey: getFormatOverviewFileKey(alert),
    fileLabel: getFormatOverviewFileLabel(alert),
    checkOrder: getFormatOverviewCheckOrder(alert && alert.subType),
    page: pages[0] || null,
  }
}

function compareFormatOverviewAlerts(a, b) {
  var aInfo = getFormatOverviewSortInfo(a)
  var bInfo = getFormatOverviewSortInfo(b)

  if (aInfo.fileKey && bInfo.fileKey && aInfo.fileKey !== bInfo.fileKey) {
    return aInfo.fileKey.localeCompare(bInfo.fileKey)
  }
  if (aInfo.fileKey && !bInfo.fileKey) return -1
  if (!aInfo.fileKey && bInfo.fileKey) return 1

  if (aInfo.checkOrder !== bInfo.checkOrder) return aInfo.checkOrder - bInfo.checkOrder

  var pageOrder = compareOptionalNumber(aInfo.page, bInfo.page)
  if (pageOrder !== 0) return pageOrder

  return String((a && a.id) || '').localeCompare(String((b && b.id) || ''))
}

function sortFormatOverviewAlerts(alerts) {
  return arrayify(alerts).slice().sort(compareFormatOverviewAlerts)
}

function buildFormatOverviewFileGroups(alerts) {
  var groups = {}
  var order = []

  sortFormatOverviewAlerts(alerts).forEach(function (alert) {
    var info = getFormatOverviewSortInfo(alert)
    var key = info.fileKey || 'unknown'
    if (!groups[key]) {
      groups[key] = {
        key: key,
        label: info.fileLabel,
        alerts: [],
      }
      order.push(key)
    }
    groups[key].alerts.push(alert)
  })

  return order.map(function (key) { return groups[key] })
}

function getReviewStatusText(status) {
  if (!status) return '待审核'
  return status.status === 'passed' ? '已忽略' : '已保留'
}

export default function ReviewPage() {
  var [searchParams, setSearchParams] = useSearchParams()
  var [projects, setProjects] = useState([])
  var [selectedProjectId, setSelectedProjectId] = useState(searchParams.get('projectId') || '')
  var [results, setResults] = useState(null)
  var [projectDetail, setProjectDetail] = useState(null)
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
      setProjectDetail(null)
      return
    }

    setIsLoading(true)
    Promise.all([
      getProjectResults(projectId),
      getProjectDetail(projectId).catch(function () { return null }),
    ]).then(function (responses) {
      var data = responses[0]
      var loadedProjectDetail = responses[1]
      var projectResults = normalizeProjectResultsPayload(data)
      setResults(projectResults)
      setProjectDetail(loadedProjectDetail)
      var alerts = enrichAlertsWithProjectFiles(collectAllAlerts(projectResults), loadedProjectDetail)
      setAllAlerts(alerts)
      setSelectedAlerts(new Set())
      setCurrentServiceType(null)
      setCurrentAlertIndex(0)
    }).catch(function () {
      setProjectDetail(null)
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
    setProjectDetail(null)
    setCurrentServiceType(null)
    setCurrentAlertIndex(0)
  }

  // Compute alerts for current service type
  var serviceAlerts = currentServiceType
    ? sortAlertsForDisplay(allAlerts.filter(function (a) { return a.resultType === currentServiceType }))
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

  function openAlertFromOverview(alert) {
    if (!alert) return
    var sortedAlerts = sortAlertsForDisplay(allAlerts.filter(function (item) {
      return item.resultType === alert.resultType
    }))
    var targetIndex = sortedAlerts.findIndex(function (item) {
      return item.id === alert.id
    })

    setCurrentServiceType(alert.resultType)
    setCurrentAlertIndex(targetIndex >= 0 ? targetIndex : 0)
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

  async function persistFrontendResult(payload) {
    return updateResultForFrontend(selectedProjectId, payload)
  }

  async function handleExportJson() {
    if (!selectedProjectId || selectedAlerts.size === 0) return

    setExportLoading(true)
    try {
      var payload = buildFilteredResultJson(allAlerts, selectedAlerts, overviewResultKeys)
      await persistFrontendResult(payload)
      downloadJsonFile('review-result-' + selectedProjectId + '.json', payload)

      setNotice({ type: 'success', message: '过滤后的结果已回传并导出' })
      setShowExport(false)
    } catch (e) {
      setNotice({ type: 'error', message: '导出失败: ' + (e.message || '未知错误') })
    } finally {
      setExportLoading(false)
    }
  }

  async function handleExportWord() {
    if (!selectedProjectId || selectedAlerts.size === 0) return

    setExportLoading(true)
    try {
      var payload = buildFilteredResultJson(allAlerts, selectedAlerts, overviewResultKeys)
      var response = await persistFrontendResult(payload)
      var reportUrl = getReportDownloadUrl(response)
      var reportName = response?.report_name || ('review-report-' + selectedProjectId + '.docx')

      if (reportUrl) {
        downloadUrl(reportUrl, reportName)
        setNotice({ type: 'success', message: '过滤后的结果已回传，Word 报告已生成' })
      } else {
        setNotice({ type: 'success', message: '过滤后的结果已回传，Word 报告已生成但未返回下载地址' })
      }
      setShowExport(false)
    } catch (e) {
      setNotice({ type: 'error', message: '导出 Word 报告失败: ' + (e.message || '未知错误') })
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

  var currentProject = projects.find(function (project) {
    return String(getProjectIdentifierValue(project) || '') === String(selectedProjectId || '')
  })
  var projectTitle = getProjectTitle(projectDetail, currentProject, selectedProjectId)
  var projectFiles = getProjectOverviewFiles(projectDetail)
  var overviewResultKeys = getOverviewResultKeys(results, resultTypeKeys)
  var overviewSections = overviewResultKeys.map(function (key) {
    var sectionAlerts = allAlerts.filter(function (alert) { return alert.resultType === key })
    return {
      key: key,
      label: RESULT_TYPE_LABELS[key] || key,
      color: RESULT_TYPE_COLORS[key] || '#64748b',
      alerts: key === 'business_bid_format_review' ? sortFormatOverviewAlerts(sectionAlerts) : sortAlertsForDisplay(sectionAlerts),
    }
  })
  var overviewCards = [{
    key: 'total',
    label: '全部可疑项',
    value: totalCount,
    color: '#0f766e',
  }, {
    key: 'high',
    label: '高风险',
    value: countAlertsByRisk(allAlerts, 'high'),
    color: '#dc2626',
  }].concat(overviewSections.map(function (section) {
    return {
      key: section.key,
      label: section.label,
      value: section.alerts.length,
      color: section.color,
    }
  }))

  // Build PDF panels for current alert
  var pdfDocIds = currentAlert ? getAlertDocIds(currentAlert) : []

  function renderOverviewRows(alerts, emptyText) {
    return arrayify(alerts).length === 0 ? (
      <tr>
        <td colSpan={6} className="overview-empty-cell">{emptyText}</td>
      </tr>
    ) : alerts.map(function (alert) {
      var docs = getOverviewAlertDocs(alert)
      var status = reviewStatus[alert.id]
      return (
        <tr key={alert.id}>
          <td>
            <span className={'risk-tag ' + (RISK_CLASSES[alert.riskLevel] || 'risk-none')}>
              {RISK_LABELS[alert.riskLevel] || alert.riskLevel}
            </span>
          </td>
          <td className="overview-doc-cell">
            {docs.length > 0 ? docs.map(function (doc, docIndex) {
              var docKey = doc.docKey || doc.docId || doc.fileName || doc.label || docIndex
              return (
                <div className="overview-doc-line" key={docKey}>
                  <strong>{doc.label || doc.fileName || '关联文件'}</strong>
                  <span>{formatOverviewPageList(doc)}</span>
                </div>
              )
            }) : (
              <span className="overview-muted">无关联文件</span>
            )}
          </td>
          <td className="overview-issue-cell">
            <strong>{alert.title}</strong>
            <span>{alert.description}</span>
          </td>
          <td>{getAlertMetricSummary(alert)}</td>
          <td>
            <span className={'review-badge ' + (status && status.status === 'passed' ? 'badge-passed' : status ? 'badge-flagged' : '')}>
              {getReviewStatusText(status)}
            </span>
          </td>
          <td>
            <button
              type="button"
              className="ghost-button overview-open-button"
              onClick={function () { openAlertFromOverview(alert) }}
            >
              查看
            </button>
          </td>
        </tr>
      )
    })
  }

  function renderOverviewTable(alerts, emptyText) {
    return (
      <div className="overview-table-wrap">
        <table className="overview-table">
          <thead>
            <tr>
              <th>风险</th>
              <th>文件与页码</th>
              <th>问题</th>
              <th>指标</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {renderOverviewRows(alerts, emptyText)}
          </tbody>
        </table>
      </div>
    )
  }

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
              <button
                type="button"
                className={'filter-card' + (!currentServiceType ? ' filter-card-active' : '')}
                style={!currentServiceType ? { borderColor: '#0f766e', background: '#ecfdf5' } : {}}
                onClick={function () { selectServiceType(null) }}
              >
                <span
                  className="filter-card-dot"
                  style={{ background: !currentServiceType ? '#0f766e' : '#cbd5e1' }}
                />
                <span className="filter-card-label">总览</span>
                <span
                  className="filter-card-count"
                  style={!currentServiceType ? { background: '#0f766e', color: '#fff' } : {}}
                >
                  {totalCount}
                </span>
              </button>

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
              results ? (
                <div className="overview-container">
                  <section className="panel review-overview-head">
                    <div className="overview-title-row">
                      <div>
                        <span className="overview-kicker">全项目</span>
                        <h3>项目级审查总览</h3>
                        <p>{projectTitle}</p>
                      </div>
                      <span className="overview-scope">当前视角：全项目</span>
                    </div>

                    <div className="review-overview-stats">
                      {overviewCards.map(function (card) {
                        return (
                          <button
                            type="button"
                            key={card.key}
                            className="overview-stat-card"
                            onClick={function () {
                              if (card.key !== 'total' && card.key !== 'high') selectServiceType(card.key)
                            }}
                            disabled={card.key === 'high'}
                          >
                            <span>{card.label}</span>
                            <strong style={{ color: card.color }}>{card.value}</strong>
                          </button>
                        )
                      })}
                    </div>
                  </section>

                  {projectFiles.length > 0 ? (
                    <section className="panel overview-files-panel">
                      <div className="overview-section-head">
                        <h3>项目文件</h3>
                        <span>{projectFiles.length} 份</span>
                      </div>
                      <div className="overview-file-list">
                        {projectFiles.map(function (file) {
                          return (
                            <div className="overview-file-item" key={file.type + '-' + file.name}>
                              <span>{file.type}</span>
                              <strong>{file.name}</strong>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  ) : null}

                  <div className="overview-section-list">
                    {overviewSections.length > 0 ? overviewSections.map(function (section) {
                      return (
                        <section className="panel overview-issue-section" key={section.key}>
                          <div className="overview-section-head">
                            <h3>{section.label}</h3>
                            <span>{section.alerts.length} 项</span>
                          </div>

                          {section.key === 'business_bid_format_review' ? (
                            <div className="overview-format-groups">
                              {section.alerts.length === 0 ? renderOverviewTable([], '未发现该类问题') : buildFormatOverviewFileGroups(section.alerts).map(function (group) {
                                return (
                                  <div className="overview-format-group" key={group.key}>
                                    <div className="overview-format-group-head">
                                      <strong>{group.label}</strong>
                                      <span>{group.alerts.length} 项</span>
                                    </div>
                                    {renderOverviewTable(group.alerts, '未发现该文件的形式审查问题')}
                                  </div>
                                )
                              })}
                            </div>
                          ) : (
                          <div className="overview-table-wrap">
                            <table className="overview-table">
                              <thead>
                                <tr>
                                  <th>风险</th>
                                  <th>文件与页码</th>
                                  <th>问题</th>
                                  <th>指标</th>
                                  <th>状态</th>
                                  <th>操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {section.alerts.length === 0 ? (
                                  <tr>
                                    <td colSpan={6} className="overview-empty-cell">未发现该类问题</td>
                                  </tr>
                                ) : section.alerts.map(function (alert) {
                                  var docs = getOverviewAlertDocs(alert)
                                  var status = reviewStatus[alert.id]
                                  return (
                                    <tr key={alert.id}>
                                      <td>
                                        <span className={'risk-tag ' + (RISK_CLASSES[alert.riskLevel] || 'risk-none')}>
                                          {RISK_LABELS[alert.riskLevel] || alert.riskLevel}
                                        </span>
                                      </td>
                                      <td className="overview-doc-cell">
                                        {docs.length > 0 ? docs.map(function (doc, docIndex) {
                                          var docKey = doc.docKey || doc.docId || doc.fileName || doc.label || docIndex
                                          return (
                                            <div className="overview-doc-line" key={docKey}>
                                              <strong>{doc.label || doc.fileName || '关联文件'}</strong>
                                              <span>{formatOverviewPageList(doc)}</span>
                                            </div>
                                          )
                                        }) : (
                                          <span className="overview-muted">无关联文件</span>
                                        )}
                                      </td>
                                      <td className="overview-issue-cell">
                                        <strong>{alert.title}</strong>
                                        <span>{alert.description}</span>
                                      </td>
                                      <td>{getAlertMetricSummary(alert)}</td>
                                      <td>
                                        <span className={'review-badge ' + (status && status.status === 'passed' ? 'badge-passed' : status ? 'badge-flagged' : '')}>
                                          {getReviewStatusText(status)}
                                        </span>
                                      </td>
                                      <td>
                                        <button
                                          type="button"
                                          className="ghost-button overview-open-button"
                                          onClick={function () { openAlertFromOverview(alert) }}
                                        >
                                          查看
                                        </button>
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                          )}
                        </section>
                      )
                    }) : (
                      <section className="panel overview-issue-section">
                        <EmptyBlock title="暂无分析结果" />
                      </section>
                    )}
                  </div>
                </div>
              ) : (
                <EmptyBlock title="暂无分析结果" />
              )
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
                            {docInfo.label || '文档'}：{formatPreviewPageLabel(docInfo, page, pageCount)}
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
                                    定位{formatPreviewPageLabel(docInfo, currentPage, pageCount)}
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
                <p>将按问题种类、问题文件页码顺序导出已保留项，不包含已忽略项。导出使用原始完整结果内容，不使用总览中的省略展示文本。</p>
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
                onClick={handleExportWord}
              >
                {exportLoading ? '导出中...' : '导出 Word 报告'}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={exportLoading}
                onClick={handleExportJson}
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
