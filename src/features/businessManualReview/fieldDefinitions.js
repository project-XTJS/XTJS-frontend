import { MANUAL_REVIEW_GROUP_LABELS } from './constants'
import {
  extractManualReviewAmount,
  getManualReviewObjectValue,
  getManualReviewPathValue,
  isManualValueBlank,
  isManualReviewFieldNotRequired,
} from './valueUtils'

function buildTemplateDifferenceFallback(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  var lines = []
  var missingAnchors = Array.isArray(value.missing_anchors) ? value.missing_anchors : []
  var unfilledFields = Array.isArray(value.unfilled_fields) ? value.unfilled_fields : []
  if (missingAnchors.length > 0) {
    lines.push('投标文件缺少模板固定内容：' + missingAnchors.join('、'))
  }
  if (unfilledFields.length > 0) {
    lines.push('投标文件存在未填写字段：' + unfilledFields.map(function (field) {
      if (field && typeof field === 'object') return field.label || field.name || field.field || JSON.stringify(field)
      return String(field || '')
    }).filter(Boolean).join('、'))
  }
  return lines.join('\n')
}

function collectTemplateDifferenceItems(value) {
  var items = getManualReviewObjectValue(value, ['difference_items'])
  return Array.isArray(items) ? items : []
}

function getTemplateDifferenceItemKey(item) {
  return [
    item.item_id,
    item.type,
    item.difference_category,
    item.label,
    item.template_text,
    item.reference_text,
    item.page,
  ].map(function (value) { return String(value || '').trim() }).join('|')
}

function isTemplateViolationDifferenceItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false
  var category = String(item.difference_category || '').trim().toLowerCase()
  var type = String(item.type || category).trim().toLowerCase()
  var status = String(item.status || '').trim().toLowerCase()
  var allowedCategory = ['allowed_variable', 'format_only'].indexOf(category) >= 0 ||
    ['allowed_variable', 'format_only'].indexOf(type) >= 0
  if (allowedCategory) return false
  if (['pass', 'passed', 'ok', 'found', 'skipped'].indexOf(status) >= 0) return false
  if (['missing', 'fail', 'failed', 'unclear'].indexOf(status) >= 0) return true
  if ([
    'fixed_clause_missing',
    'possible_rewrite',
    'alignment_unclear',
    'delete',
    'insert',
    'replace',
    'missing',
  ].indexOf(type) >= 0) return true
  return Boolean(item.template_text || item.reference_text || item.bid_text || item.matched_text)
}

function isTemplateSegmentPassed(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.is_passed === true) return true
  var status = String(
    value.manual_status ||
    value.consistency_status ||
    value.status ||
    value.result ||
    ''
  ).trim().toLowerCase()
  if (['pass', 'passed', 'ok', 'found', 'skipped', 'true', '通过', '一致'].indexOf(status) >= 0) return true
  var summary = String(value.difference_summary || value.summary || value.message || '').trim()
  return /所有必检|均已通过|未发现.*(?:改动|差异)/.test(summary)
}

function buildTemplateViolationDifferenceItems(currentValue, originalValue) {
  var seen = {}
  return collectTemplateDifferenceItems(currentValue)
    .concat(collectTemplateDifferenceItems(originalValue))
    .filter(isTemplateViolationDifferenceItem)
    .filter(function (item) {
      var key = getTemplateDifferenceItemKey(item)
      if (seen[key]) return false
      seen[key] = true
      return true
    })
}

function manualNumber(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  var text = String(value).replace(/,/g, '').trim()
  var match = text.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  var number = Number(match[0])
  return Number.isFinite(number) ? number : null
}

function manualNumberFromKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return manualNumber(value)
  for (var index = 0; index < keys.length; index += 1) {
    var number = manualNumber(value[keys[index]])
    if (number !== null) return number
  }
  return null
}

function formatManualNumber(value) {
  var number = manualNumber(value)
  return number === null ? '' : number.toFixed(2)
}

function rateQuoteText(value, originalValue, keys) {
  return getManualReviewObjectValue(value, keys) || getManualReviewObjectValue(originalValue, keys)
}

function rateQuoteCurrentLabel(value, originalValue) {
  var rateLabel = String(rateQuoteText(value, originalValue, ['rate_label']) || '')
  return rateLabel.indexOf('折扣率') >= 0 ? '当前折扣率（%）' : '当前下浮率（%）'
}

function rateQuoteThresholdLabel(value, originalValue) {
  var rateLabel = String(rateQuoteText(value, originalValue, ['rate_label']) || '')
  var operator = String(rateQuoteText(value, originalValue, ['rule_operator', 'op']) || '').trim()
  if (rateLabel.indexOf('折扣率') >= 0 || operator === '<' || operator === '<=') {
    return '要求最高折扣率（%）'
  }
  return '要求最低下浮率（%）'
}

export function buildManualReviewDisplayFields(item, currentValue) {
  var originalValue = item.original_value
  var fields = []

  function addField(config) {
    var sourceKeys = config.sourceKeys || (config.path ? [config.path[config.path.length - 1]] : [])
    var originalFieldValue = config.originalValue
    var currentFieldValue = config.currentValue
    var currentPathValue

    if (originalFieldValue === undefined) originalFieldValue = getManualReviewObjectValue(originalValue, sourceKeys)
    if (currentFieldValue === undefined) {
      currentPathValue = getManualReviewPathValue(currentValue, config.path)
      currentFieldValue = currentPathValue
    }
    if (currentFieldValue === undefined) currentFieldValue = getManualReviewObjectValue(currentValue, sourceKeys)
    if (config.useOriginalValueWhenCurrentMissing && currentPathValue === undefined && isManualValueBlank(currentFieldValue) && !isManualValueBlank(originalFieldValue)) {
      currentFieldValue = originalFieldValue
    }
    if (config.amountFallback) {
      if (isManualValueBlank(originalFieldValue)) originalFieldValue = extractManualReviewAmount(originalValue)
      if (isManualValueBlank(currentFieldValue)) currentFieldValue = extractManualReviewAmount(currentValue)
    }

    var notRequired = isManualReviewFieldNotRequired(originalValue, config) || isManualReviewFieldNotRequired(currentValue, config)
    fields.push(Object.assign({}, config, {
      key: config.key || (config.path && config.path.join('.')) || 'value',
      originalFieldValue: originalFieldValue,
      currentFieldValue: currentFieldValue,
      readOnly: config.readOnly || notRequired,
      notRequired: notRequired,
    }))
  }

  if (item.field_group === 'opening_amount') {
    addField({ path: ['small_amount_yuan'], label: '小写报价（元）', valueType: 'amount', sourceKeys: ['small_amount_yuan', 'small_amount', 'amount_yuan', 'amount', 'declared_total'], amountFallback: true })
    addField({ path: ['capital_amount_yuan'], label: '大写报价（元）', valueType: 'amount', sourceKeys: ['capital_amount_yuan', 'capital_amount', 'capital_price'] })
    addField({ path: ['case_consistency_status'], label: '大小写是否一致', valueType: 'text', sourceKeys: ['case_consistency_status', 'case_consistency_summary'], readOnly: true })
    addField({ path: ['limit_comparison_status'], label: '是否超过最高限价', valueType: 'text', sourceKeys: ['limit_comparison_status', 'price_limit_status', 'tender_limit_status', 'limit_comparison_summary'], readOnly: true })
    return fields
  }

  if (item.field_group === 'rate_quote') {
    addField({
      path: ['current_float_rate'],
      label: rateQuoteCurrentLabel(currentValue, originalValue),
      valueType: 'amount',
      sourceKeys: ['current_float_rate', 'float_rate'],
      amountFallback: true,
    })
    addField({
      path: ['required_min_float_rate'],
      label: rateQuoteThresholdLabel(currentValue, originalValue),
      valueType: 'amount',
      sourceKeys: ['required_min_float_rate', 'rule_threshold', 'threshold'],
      amountFallback: true,
    })
    return fields
  }

  if (item.field_group === 'price_constraint') {
    addField({ path: ['amount_yuan'], label: '招标文件最高限价（元）', valueType: 'amount', sourceKeys: ['amount_yuan', 'amount', 'limit_amount_yuan'], amountFallback: true })
    return fields
  }

  if (item.field_group === 'price_limit_comparison') {
    addField({ path: ['summary'], label: '是否超过最高限价', valueType: 'text', sourceKeys: ['summary', 'message'], multiline: true, readOnly: true })
    addField({ path: ['status'], label: '系统判断', valueType: 'text', sourceKeys: ['status', 'result'], readOnly: true })
    return fields
  }

  if (item.field_group === 'bid_total_amount') {
    addField({ path: ['amount_yuan'], label: '投标总价（元）', valueType: 'amount', sourceKeys: ['amount_yuan', 'amount', 'declared_total', 'small_amount'], amountFallback: true })
    addField({ path: ['raw_amount'], label: '投标总价原文', valueType: 'text', sourceKeys: ['raw_amount', 'amount_text', 'summary', 'matched_text', 'text'], multiline: true })
    return fields
  }

  if (item.field_group === 'itemized_amount') {
    var itemizedLabel = [originalValue && originalValue.serial, item.field_name].filter(Boolean).join(' / ') || item.field_name || '当前分项'
    var originalQuantity = manualNumberFromKeys(originalValue, ['quantity'])
    var originalUnitPrice = manualNumberFromKeys(originalValue, ['unit_price'])
    var currentQuantity = manualNumberFromKeys(currentValue, ['quantity'])
    var currentUnitPrice = manualNumberFromKeys(currentValue, ['unit_price'])
    var originalCalculated = originalQuantity !== null && originalUnitPrice !== null
      ? (originalQuantity * originalUnitPrice).toFixed(2)
      : formatManualNumber(getManualReviewObjectValue(originalValue, ['calculated_total', 'expected_total', 'amount_yuan', 'amount']))
    var currentCalculated = currentQuantity !== null && currentUnitPrice !== null
      ? (currentQuantity * currentUnitPrice).toFixed(2)
      : formatManualNumber(getManualReviewObjectValue(currentValue, ['calculated_total', 'expected_total', 'amount_yuan', 'amount']))
    var originalOcrTotal = formatManualNumber(getManualReviewObjectValue(originalValue, ['ocr_total', 'declared_line_total', 'line_total', 'amount_yuan', 'amount']))
    var currentOcrTotal = formatManualNumber(getManualReviewObjectValue(currentValue, ['ocr_total', 'declared_line_total', 'line_total', 'amount_yuan', 'amount']))
    var originalDifference = originalCalculated && originalOcrTotal ? (Number(originalCalculated) - Number(originalOcrTotal)).toFixed(2) : getManualReviewObjectValue(originalValue, ['difference'])
    var currentDifference = currentCalculated && currentOcrTotal ? (Number(currentCalculated) - Number(currentOcrTotal)).toFixed(2) : getManualReviewObjectValue(currentValue, ['difference'])
    addField({ path: ['item_label'], label: '分项名称/编号', valueType: 'text', originalValue: itemizedLabel, currentValue: itemizedLabel, readOnly: true })
    addField({ path: ['quantity'], label: '数量', valueType: 'amount', sourceKeys: ['quantity'] })
    addField({ path: ['unit_price'], label: '单价（元）', valueType: 'amount', sourceKeys: ['unit_price'] })
    addField({ path: ['ocr_total'], label: '原表格OCR小计（元）', valueType: 'amount', sourceKeys: ['ocr_total', 'declared_line_total', 'line_total', 'amount_yuan', 'amount'], amountFallback: true })
    addField({ path: ['calculated_total'], label: '系统计算小计（数量×单价）', valueType: 'amount', originalValue: originalCalculated, currentValue: currentCalculated, readOnly: true })
    addField({ path: ['difference'], label: '行小计差额（计算-OCR）', valueType: 'amount', originalValue: originalDifference, currentValue: currentDifference, readOnly: true })
    addField({ path: ['row_status'], label: '行算术校验', valueType: 'text', sourceKeys: ['row_status', 'status'], readOnly: true })
    addField({ path: ['raw_amount'], label: '该分项OCR来源', valueType: 'text', sourceKeys: ['raw_amount', 'amount_text', 'summary', 'matched_text', 'text', 'source'], multiline: true, readOnly: true })
    return fields
  }

  if (item.field_group === 'itemized_total') {
    addField({ path: ['total_label'], label: '合计项说明', valueType: 'text', originalValue: item.field_name || '分项报价表合计', currentValue: item.field_name || '分项报价表合计', readOnly: true })
    addField({ path: ['declared_total'], label: '分项报价表合计金额（元）', valueType: 'amount', sourceKeys: ['declared_total', 'amount_yuan', 'amount', 'total_amount'], amountFallback: true })
    addField({ path: ['calculated_total'], label: '所有分项计算小计合计（元）', valueType: 'amount', sourceKeys: ['calculated_total'], readOnly: true })
    addField({ path: ['difference'], label: '汇总差额（计算合计-OCR总计）', valueType: 'amount', sourceKeys: ['difference'], readOnly: true })
    addField({ path: ['summary_status'], label: '汇总一致性校验', valueType: 'text', sourceKeys: ['summary_status', 'status'], readOnly: true })
    addField({ path: ['raw_amount'], label: '合计金额OCR来源', valueType: 'text', sourceKeys: ['raw_amount', 'amount_text', 'summary', 'matched_text', 'text', 'source'], multiline: true, readOnly: true })
    return fields
  }

  if (item.field_group === 'template_segment') {
    var templateSegmentPassed = isTemplateSegmentPassed(currentValue) || isTemplateSegmentPassed(originalValue)
    var templateViolationItems = templateSegmentPassed ? [] : buildTemplateViolationDifferenceItems(currentValue, originalValue)
    addField({
      path: ['difference_summary'],
      label: templateViolationItems.length > 0 ? '导致不通过的固定模板差异' : '固定模板一致性结果',
      valueType: 'difference_list',
      differenceMode: templateViolationItems.length > 0 ? 'template_violation' : 'template_pass',
      sourceKeys: ['difference_summary'],
      originalValue: getManualReviewObjectValue(originalValue, ['difference_summary']) || buildTemplateDifferenceFallback(originalValue),
      currentValue: getManualReviewObjectValue(currentValue, ['difference_summary']) || buildTemplateDifferenceFallback(currentValue),
      differenceItems: templateViolationItems,
      multiline: true,
      readOnly: true,
    })
    addField({
      path: ['manual_status'],
      label: '人工复核结论',
      valueType: 'status',
      sourceKeys: ['manual_status', 'consistency_status', 'status', 'result'],
    })
    return fields
  }

  if (item.field_group === 'attachment_result') {
    addField({ path: ['date_text'], label: '落款日期', valueType: 'text', sourceKeys: ['date_text', 'date', 'sign_date'], fallbackStatusKeys: ['date_status'] })
    addField({ path: ['deadline_date'], label: '最晚截止日期', valueType: 'text', sourceKeys: ['deadline_date', 'deadline_text', 'matched_deadline_text'], fallbackStatusKeys: ['date_status'], locateTarget: 'deadline' })
    addField({ path: ['signature_evidence'], label: '签字识别内容（每行一个）', valueType: 'array', sourceKeys: ['signature_evidence', 'signature_texts', 'signature_text'], fallbackStatusKeys: ['signature_parse_status', 'signature_status'], multiline: true, useOriginalValueWhenCurrentMissing: true })
    addField({ path: ['seal_texts'], label: '盖章识别内容（每行一个）', valueType: 'array', sourceKeys: ['seal_texts', 'seal_evidence', 'seal_text'], fallbackStatusKeys: ['seal_status'], multiline: true, useOriginalValueWhenCurrentMissing: true })
    return fields
  }

  addField({ path: [], label: MANUAL_REVIEW_GROUP_LABELS[item.field_group] || item.field_name || '识别内容', valueType: 'text', originalValue: originalValue, currentValue: currentValue, multiline: true })
  return fields
}
