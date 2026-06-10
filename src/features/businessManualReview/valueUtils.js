import {
  MANUAL_REVIEW_GROUP_LABELS,
  MANUAL_REVIEW_KEY_LABELS,
  MANUAL_REVIEW_STATUS_LABELS,
} from './constants'

export function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

export function arrayify(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

export function getLookupKey(value) {
  return String(value || '').trim().toLowerCase()
}

export function stringifyManualReviewValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export function isManualValueBlank(value) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

export function parseManualReviewValue(text, originalValue) {
  var raw = String(text ?? '').trim()
  if (!raw) return ''
  if (isObject(originalValue) || Array.isArray(originalValue) || raw[0] === '{' || raw[0] === '[') {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  var normalizedNumber = raw.replace(/,/g, '')
  if (/^-?\d+(\.\d+)?$/.test(normalizedNumber)) return Number(normalizedNumber)
  return raw
}

export function manualReviewItemLabel(item) {
  return (MANUAL_REVIEW_GROUP_LABELS[item.field_group] || item.field_group || '识别内容') + ' / ' + (item.field_name || item.result_path || '')
}

function manualReviewStatusLabel(value) {
  var key = String(value === undefined || value === null ? '' : value).trim()
  return MANUAL_REVIEW_STATUS_LABELS[key] || key
}

function isSignatureManualReviewField(field) {
  var pathKey = field && field.path && field.path[0]
  return ['signature_text', 'signature_texts', 'signature_evidence'].includes(pathKey)
}

function isUnparsedSignatureStatus(status) {
  return ['unparsed', 'pass', 'found', 'pending'].includes(String(status || '').trim().toLowerCase())
}

function isCaseConsistencyField(field) {
  return field && field.path && field.path[0] === 'case_consistency_status'
}

function formatCaseConsistencyValue(value) {
  var raw = String(value === undefined || value === null ? '' : value).trim()
  var key = raw.toLowerCase()
  if (!raw) return '缺少信息'
  if (['pass', 'passed', 'ok', 'consistent', 'match', 'matched', '一致'].includes(key)) return '一致'
  if (['fail', 'failed', 'inconsistent', 'mismatch', 'not_match', 'not matched', '不一致'].includes(key)) return '不一致'
  if (['missing', 'missing_info', 'unparsed', 'unclear', 'unknown', '缺少信息'].includes(key)) return '缺少信息'
  if (raw.indexOf('不一致') >= 0 || raw.indexOf('不匹配') >= 0) return '不一致'
  if (raw.indexOf('缺少') >= 0 || raw.indexOf('缺失') >= 0 || raw.indexOf('未识别') >= 0 || raw.indexOf('无法') >= 0) return '缺少信息'
  if (raw.indexOf('一致') >= 0 || raw.indexOf('匹配') >= 0) return '一致'
  return raw
}

export function collectManualReviewText(value, output) {
  if (value === undefined || value === null) return output
  if (Array.isArray(value)) {
    value.forEach(function (item) { collectManualReviewText(item, output) })
    return output
  }
  if (isObject(value)) {
    Object.entries(value).forEach(function (entry) {
      if (entry[0] === 'locations' || entry[0] === 'pages') return
      collectManualReviewText(entry[1], output)
    })
    return output
  }
  var text = String(value).trim()
  if (text) output.push(text)
  return output
}

export function extractManualReviewAmount(value) {
  var text = collectManualReviewText(value, []).join(' ')
  var match = text.match(/(?:￥|¥)?\s*(-?\d[\d,]*(?:\.\d+)?)/)
  return match ? match[1].replace(/,/g, '') : ''
}

export function formatManualReviewDisplayValue(value) {
  if (isManualValueBlank(value)) return '未识别'
  if (Array.isArray(value)) {
    var list = value.map(formatManualReviewDisplayValue).filter(function (item) {
      return item && item !== '未识别'
    })
    return list.length ? list.join('、') : '未识别'
  }
  if (isObject(value)) {
    var preferred = []
    ;[
      'result',
      'status',
      'raw_amount',
      'amount_yuan',
      'capital_amount',
      'declared_total',
      'signature_text',
      'seal_text',
      'date_text',
      'date',
      'deadline_date',
      'deadline_text',
      'matched_deadline_text',
      'summary',
      'message',
    ].forEach(function (key) {
      if (!isManualValueBlank(value[key])) {
        preferred.push((MANUAL_REVIEW_KEY_LABELS[key] || key) + '：' + formatManualReviewDisplayValue(value[key]))
      }
    })
    if (preferred.length) return preferred.join('；')
    return collectManualReviewText(value, []).slice(0, 3).join('；') || '已识别'
  }
  return manualReviewStatusLabel(value)
}

export function getManualReviewObjectValue(value, keys) {
  if (!isObject(value)) return undefined
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i]
    if (!isManualValueBlank(value[key])) return value[key]
  }
  return undefined
}

export function getManualReviewPathValue(value, path) {
  if (!path || path.length === 0) return value
  var current = value
  for (var i = 0; i < path.length; i += 1) {
    if (!isObject(current) && !Array.isArray(current)) return undefined
    current = current[path[i]]
  }
  return current
}

export function setManualReviewPathValue(value, path, nextValue) {
  if (!path || path.length === 0) return nextValue
  var root = isObject(value) && !Array.isArray(value) ? Object.assign({}, value) : {}
  var cursor = root
  path.forEach(function (key, index) {
    if (index === path.length - 1) {
      cursor[key] = nextValue
      return
    }
    var child = cursor[key]
    cursor[key] = isObject(child) && !Array.isArray(child) ? Object.assign({}, child) : {}
    cursor = cursor[key]
  })
  return root
}

export function getManualReviewCurrentValue(item, manualDrafts) {
  var draftText = manualDrafts[item.editable_id]
  if (draftText !== undefined) return parseManualReviewValue(draftText, item.original_value)
  if (item.manual_value !== undefined && item.manual_value !== null) return item.manual_value
  return item.original_value
}

export function stringifyManualFieldInput(value, valueType) {
  if (valueType === 'array') {
    if (Array.isArray(value)) return value.map(function (item) { return String(item || '') }).join('\n')
    return String(value || '')
  }
  if (isObject(value) || Array.isArray(value)) return formatManualReviewDisplayValue(value)
  return value === undefined || value === null ? '' : String(value)
}

export function parseManualFieldInput(text, field) {
  var raw = String(text ?? '').trim()
  if (field.valueType === 'array') {
    if (!raw) return []
    return raw.split(/\r?\n|、|；|;/).map(function (item) {
      return item.trim()
    }).filter(Boolean)
  }
  if (!raw) return ''
  if (field.valueType === 'amount') {
    var normalized = raw.replace(/,/g, '')
    if (/^-?\d+(\.\d+)?$/.test(normalized)) return Number(normalized)
  }
  return raw
}

export function areManualReviewValuesEqual(left, right) {
  try {
    return JSON.stringify(left === undefined ? null : left) === JSON.stringify(right === undefined ? null : right)
  } catch {
    return String(left ?? '') === String(right ?? '')
  }
}

export function getManualReviewFallbackStatus(value, field) {
  if (!field.fallbackStatusKeys || !isObject(value)) return ''
  for (var i = 0; i < field.fallbackStatusKeys.length; i += 1) {
    var status = value[field.fallbackStatusKeys[i]]
    if (!isManualValueBlank(status)) return status
  }
  return ''
}

export function isManualReviewFieldNotRequired(sourceValue, field) {
  return String(getManualReviewFallbackStatus(sourceValue, field) || '').trim() === 'not_required'
}

export function formatManualReviewFieldDisplayValue(value, field, sourceValue) {
  if (field.notRequired) return '不要求'
  var fallbackStatus = getManualReviewFallbackStatus(sourceValue, field)
  if (String(fallbackStatus || '').trim() === 'not_required') return '不要求'
  if (isCaseConsistencyField(field)) return formatCaseConsistencyValue(value)
  if (isManualValueBlank(value) && isSignatureManualReviewField(field) && isUnparsedSignatureStatus(fallbackStatus)) {
    return '无法解析识别内容'
  }
  if (!isManualValueBlank(value)) return formatManualReviewDisplayValue(value)
  return formatManualReviewDisplayValue(value)
}

export function buildManualReviewValueWithField(item, field, fieldValue, manualDrafts) {
  var currentValue = getManualReviewCurrentValue(item, manualDrafts)
  var nextValue = setManualReviewPathValue(currentValue, field.path, fieldValue)
  if (item.field_group === 'attachment_result') {
    if (field.path && field.path[0] === 'date_text') {
      var dateStatus = getManualReviewObjectValue(item.original_value, ['date_status', 'status'])
      nextValue = setManualReviewPathValue(nextValue, ['date_status'], isManualValueBlank(fieldValue) ? (dateStatus || 'missing_date') : 'pass')
    }
    if (field.path && ['signature_text', 'signature_texts', 'signature_evidence'].includes(field.path[0])) {
      var signatureStatus = getManualReviewObjectValue(item.original_value, ['signature_status', 'status'])
      nextValue = setManualReviewPathValue(nextValue, ['signature_status'], isManualValueBlank(fieldValue) ? (signatureStatus || 'missing') : 'pass')
    }
    if (field.path && ['seal_text', 'seal_texts', 'seal_evidence'].includes(field.path[0])) {
      var sealStatus = getManualReviewObjectValue(item.original_value, ['seal_status', 'status'])
      nextValue = setManualReviewPathValue(nextValue, ['seal_status'], isManualValueBlank(fieldValue) ? (sealStatus || 'missing') : 'pass')
    }
  }
  return nextValue
}
