import { arrayify, collectManualReviewText, getLookupKey, isObject } from './valueUtils'

function collectManualReviewPages(value, output) {
  if (value === undefined || value === null || typeof value === 'boolean') return output
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value > 0) output.push(value)
    return output
  }
  if (typeof value === 'string') {
    var text = value.trim()
    if (/^\d+$/.test(text)) output.push(Number(text))
    return output
  }
  if (Array.isArray(value)) {
    value.forEach(function (item) { collectManualReviewPages(item, output) })
    return output
  }
  if (isObject(value)) {
    var pageKeyGroups = [
      ['page', 'start_page', 'page_number', 'current_page', 'deadline_page'],
      ['pages', 'page_refs', 'section_pages', 'target_pages', 'template_pages'],
      ['locations', 'template_locations', 'missing_anchor_locations', 'deadline_locations'],
    ]
    pageKeyGroups.forEach(function (keys) {
      keys.forEach(function (key) {
        collectManualReviewPages(value[key], output)
      })
    })
  }
  return output
}

function getManualReviewItemPages(item) {
  var pages = []
  collectManualReviewPages(item && item.page_refs, pages)
  if (pages.length === 0) {
    if (isObject(item && item.original_value) || Array.isArray(item && item.original_value)) {
      collectManualReviewPages(item.original_value, pages)
    }
    if (isObject(item && item.manual_value) || Array.isArray(item && item.manual_value)) {
      collectManualReviewPages(item.manual_value, pages)
    }
  }
  var seen = {}
  return pages.filter(function (page) {
    if (!Number.isFinite(page) || page <= 0 || seen[page]) return false
    seen[page] = true
    return true
  })
}

function templateItemMatchesCurrentAlert(item, currentAlert) {
  if (!currentAlert || item.field_group !== 'template_segment') return false
  var itemLabel = getLookupKey(item.field_name || item.fieldName || '')
  if (!itemLabel) return false
  var alertText = [
    currentAlert.title,
    currentAlert.description,
    currentAlert.sourceItem && currentAlert.sourceItem.title,
    currentAlert.sourceItem && currentAlert.sourceItem.message,
    collectManualReviewText(currentAlert.sourceItem, []).join(' '),
  ].filter(Boolean).map(getLookupKey).join(' ')
  return Boolean(alertText && (alertText.indexOf(itemLabel) >= 0 || itemLabel.indexOf(alertText) >= 0))
}

function normalizeVerificationAttachmentTitle(value, options) {
  var stripPackageOptions = !(options && options.preservePackageOptions)
  var text = String(value || '').trim().toLowerCase()
  if (!text) return ''
  text = text
    .replace(/签字盖章日期(?:审查|检查)?/g, '')
    .replace(/附件\s*[a-z0-9一二三四五六七八九十百千万]+(?:\s*[-./]\s*[a-z0-9一二三四五六七八九十百千万]+)*/g, '')
    .replace(/^\s*\d+(?:\s*[-./]\s*\d+)*\s*/g, '')
  if (stripPackageOptions) {
    text = text.replace(/[（(][^）)]*(?:格式|包件|盖章|签字|样式|模板|原件|复印件)?[^）)]*[）)]/g, '')
  }
  text = text
    .replace(/[（）()]/g, '')
    .replace(/[^0-9a-z\u4e00-\u9fa5]/g, '')
  return text
}

function verificationItemMatchLevel(item, currentAlert) {
  if (!currentAlert || item.field_group !== 'attachment_result') return 0
  var itemCandidates = [
    item.field_name,
    item.fieldName,
    item.original_value && item.original_value.matched_bid_title,
    item.original_value && item.original_value.title,
    item.original_value && item.original_value.attachment_number,
  ]
  var strictItemKeys = itemCandidates.map(function (value) {
    return normalizeVerificationAttachmentTitle(value, { preservePackageOptions: true })
  }).filter(Boolean)
  var looseItemKeys = itemCandidates.map(normalizeVerificationAttachmentTitle).filter(Boolean)
  if (strictItemKeys.length === 0 && looseItemKeys.length === 0) return 0

  var alertCandidates = [
    currentAlert.title,
    currentAlert.sourceItem && currentAlert.sourceItem.title,
  ]
  var strictAlertKeys = alertCandidates.map(function (value) {
    return normalizeVerificationAttachmentTitle(value, { preservePackageOptions: true })
  }).filter(Boolean)
  var looseAlertKeys = alertCandidates.map(normalizeVerificationAttachmentTitle).filter(Boolean)
  if (strictAlertKeys.length === 0 && looseAlertKeys.length === 0) return 0

  var strictMatched = strictAlertKeys.some(function (alertKey) {
    return strictItemKeys.some(function (itemKey) {
      return alertKey === itemKey || alertKey.indexOf(itemKey) >= 0 || itemKey.indexOf(alertKey) >= 0
    })
  })
  if (strictMatched) return 2

  var looseMatched = looseAlertKeys.some(function (alertKey) {
    return looseItemKeys.some(function (itemKey) {
      return alertKey === itemKey || alertKey.indexOf(itemKey) >= 0 || itemKey.indexOf(alertKey) >= 0
    })
  })
  return looseMatched ? 1 : 0
}

function normalizeManualReviewSearchText(value) {
  return getLookupKey(value).replace(/\s+/g, '')
}

function getManualReviewItemSearchText(item) {
  return normalizeManualReviewSearchText([
    item && item.field_name,
    item && item.result_path,
    item && collectManualReviewText(item.original_value, []).join(' '),
    item && collectManualReviewText(item.manual_value, []).join(' '),
    item && collectManualReviewText(item.effective_value, []).join(' '),
  ].filter(Boolean).join(' '))
}

function looksLikeOpeningSheetItemizedFallback(item) {
  var text = getManualReviewItemSearchText(item)
  if (!text) return false
  var hasItemizedAnchor = /分项报价|报价明细|明细清单|工程量清单|供货清单/.test(text)
  var hasOpeningAnchor = /开标一览|报价一览/.test(text)
  var hasOpeningPriceLabel = /投标价格|投标总价|总报价|报价总价/.test(text)
  var hasCasePair = /小写|大写/.test(text)

  if (hasOpeningAnchor && !hasItemizedAnchor) return true
  if (hasOpeningPriceLabel && hasCasePair) return true
  if (item && item.field_group === 'itemized_total' && hasOpeningPriceLabel && !hasItemizedAnchor) return true
  return false
}

export function filterRealItemizedManualReviewItems(items) {
  return arrayify(items).filter(function (item) {
    if (!item || (item.field_group !== 'itemized_amount' && item.field_group !== 'itemized_total')) return false
    return !looksLikeOpeningSheetItemizedFallback(item)
  })
}

function firstPricingComparisonValue(items) {
  var comparisonItem = arrayify(items).find(function (item) {
    return item && item.field_group === 'price_limit_comparison'
  })
  if (!comparisonItem) return null
  if (isObject(comparisonItem.effective_value)) return comparisonItem.effective_value
  if (isObject(comparisonItem.manual_value)) return comparisonItem.manual_value
  if (isObject(comparisonItem.original_value)) return comparisonItem.original_value
  return null
}

function valueFromKeys(value, keys) {
  if (!isObject(value)) return undefined
  for (var index = 0; index < keys.length; index += 1) {
    var item = value[keys[index]]
    if (item !== undefined && item !== null && item !== '') return item
  }
  return undefined
}

function withPricingComparisonOnOpeningAmount(item, comparisonValue) {
  if (!comparisonValue || !item || item.field_group !== 'opening_amount') return item
  var status = valueFromKeys(comparisonValue, ['limit_comparison_status', 'status', 'result'])
  var summary = valueFromKeys(comparisonValue, ['limit_comparison_summary', 'summary', 'message'])
  if (status === undefined && summary === undefined) return item

  function mergeValue(value) {
    if (!isObject(value)) return value
    var next = Object.assign({}, value)
    if (next.limit_comparison_status === undefined && status !== undefined) next.limit_comparison_status = status
    if (next.limit_comparison_summary === undefined && summary !== undefined) next.limit_comparison_summary = summary
    return next
  }

  return Object.assign({}, item, {
    original_value: mergeValue(item.original_value),
    manual_value: mergeValue(item.manual_value),
    effective_value: mergeValue(item.effective_value),
  })
}

export function filterManualReviewItemsForPreviewDoc(items, docInfo, currentPage, allDocs, currentAlert) {
  if (!docInfo || items.length === 0) return items
  if (currentAlert && currentAlert.subType === 'pricing_check') {
    var comparisonValue = firstPricingComparisonValue(items)
    var pricingItems = items.filter(function (item) {
      return [
        'price_constraint',
        'opening_amount',
        'rate_quote',
      ].indexOf(item.field_group) >= 0
    }).map(function (item) {
      return withPricingComparisonOnOpeningAmount(item, comparisonValue)
    })
    if (pricingItems.length > 0) return pricingItems
  }
  if (currentAlert && currentAlert.subType === 'itemized_pricing_check') {
    var itemizedItems = filterRealItemizedManualReviewItems(items)
    if (itemizedItems.length > 0) return itemizedItems
    return []
  }

  var docId = String(docInfo.docId || docInfo.identifier_id || docInfo.document_identifier_id || '')
  var docFileKey = getLookupKey(docInfo.fileName || docInfo.file_name || docInfo.label)
  var pageNumber = Number(currentPage)

  var scopedItems = items.filter(function (item) {
    var itemDocId = String(item.document_identifier_id || '')
    var itemFileKey = getLookupKey(item.file_name)
    var hasDocumentScope = Boolean(itemDocId || itemFileKey)
    var documentMatches = !hasDocumentScope ||
      (itemDocId && docId && itemDocId === docId) ||
      (itemFileKey && docFileKey && itemFileKey === docFileKey) ||
      arrayify(allDocs).length <= 1
    if (!documentMatches) return false

    var pages = getManualReviewItemPages(item)
    if (
      currentAlert &&
      currentAlert.subType === 'consistency_check' &&
      item &&
      item.field_group === 'template_segment'
    ) {
      var alertPage = Number(currentAlert.page)
      if (pages.length > 0 && Number.isFinite(alertPage) && alertPage > 0 && pages.indexOf(alertPage) >= 0) {
        return Number(pageNumber) === alertPage
      }
    }
    if (
      currentAlert &&
      currentAlert.subType === 'verification_check' &&
      item &&
      item.field_group === 'attachment_result' &&
      pages.length === 0
    ) {
      return verificationItemMatchLevel(item, currentAlert) > 0
    }
    if (pages.length === 0 || !Number.isFinite(pageNumber)) {
      return item.field_group === 'template_segment' ? templateItemMatchesCurrentAlert(item, currentAlert) : true
    }
    return pages.some(function (page) { return page === pageNumber })
  })

  if (currentAlert && currentAlert.subType === 'consistency_check') {
    var templateSegmentItems = scopedItems.filter(function (item) {
      return item && item.field_group === 'template_segment'
    })
    var alertMatchedTemplateSegmentItems = templateSegmentItems.filter(function (item) {
      return templateItemMatchesCurrentAlert(item, currentAlert)
    })
    if (alertMatchedTemplateSegmentItems.length > 0) return alertMatchedTemplateSegmentItems
    if (templateSegmentItems.length > 0) return templateSegmentItems
    return scopedItems.filter(function (item) {
      return item && item.field_group !== 'template_skeleton_item'
    })
  }

  if (currentAlert && currentAlert.subType === 'verification_check') {
    var attachmentResultItems = scopedItems.filter(function (item) {
      return item && item.field_group === 'attachment_result'
    })
    var strictMatchedAttachmentResultItems = attachmentResultItems.filter(function (item) {
      return verificationItemMatchLevel(item, currentAlert) === 2
    })
    if (strictMatchedAttachmentResultItems.length > 0) return strictMatchedAttachmentResultItems
    var looseMatchedAttachmentResultItems = attachmentResultItems.filter(function (item) {
      return verificationItemMatchLevel(item, currentAlert) === 1
    })
    if (looseMatchedAttachmentResultItems.length > 0) return looseMatchedAttachmentResultItems
    return attachmentResultItems.length > 0 ? [] : scopedItems
  }

  return scopedItems
}
