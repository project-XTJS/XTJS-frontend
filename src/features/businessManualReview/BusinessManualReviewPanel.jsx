import { useState } from 'react'
import './manualReview.css'
import {
  MANUAL_REVIEW_STATUS_OPTIONS,
  buildManualReviewDisplayFields,
  buildManualReviewValueWithField,
  filterManualReviewItemsForPreviewDoc,
  formatManualReviewFieldDisplayValue,
  getManualReviewCurrentValue,
  isManualValueBlank,
  manualReviewItemLabel,
  parseManualFieldInput,
  stringifyManualFieldInput,
  stringifyManualReviewValue,
} from './manualReviewUtils'

function arrayify(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function getManualReviewFieldKey(item, field) {
  return item.editable_id + '::' + field.key
}

function splitDifferenceSummary(value) {
  var text = String(value || '').trim()
  if (!text) return []
  return text
    .split(/\n(?=\d+\.\s*)/)
    .map(function (item) { return item.trim() })
    .filter(Boolean)
    .map(function (item) {
      var labelMatch = item.match(/^\d+\.\s*([^\n]+)/)
      return {
        label: labelMatch ? labelMatch[1].trim() : '文本差异',
        summary: item,
      }
    })
}

function getDifferenceItems(field) {
  var explicitItems = arrayify(field.differenceItems).filter(function (item) { return item && typeof item === 'object' })
  if (explicitItems.length > 0) return explicitItems
  return splitDifferenceSummary(field.currentFieldValue || field.originalFieldValue)
}

function getDifferenceItemText(item, keys) {
  if (!item || typeof item !== 'object') return ''
  for (var i = 0; i < keys.length; i += 1) {
    var value = item[keys[i]]
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim()
  }
  return ''
}

function cloneStructuredValue(value) {
  if (value === undefined || value === null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    if (Array.isArray(value)) return value.slice()
    if (typeof value === 'object') return Object.assign({}, value)
  }
  return value
}

function renderPlainDifferenceText(value, emptyText) {
  var text = String(value || '').trim()
  return text || emptyText || '无'
}

function templatePassMessage(value) {
  var text = String(value || '').trim()
  if (!text || /所有必检|均已通过|未发现/.test(text)) return '未发现固定模板内容被修改。'
  return text
}

function pushDiffSegment(segments, type, text) {
  if (!text) return
  var previous = segments[segments.length - 1]
  if (previous && previous.type === type) {
    previous.text += text
    return
  }
  segments.push({ type: type, text: text })
}

function tokenizeDiffText(value) {
  var text = String(value || '')
  return text.match(/[\u4e00-\u9fff]|[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*|\s+|[^\s]/g) || []
}

function buildSimpleTextDiff(leftText, rightText) {
  var left = String(leftText || '')
  var right = String(rightText || '')
  var prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1
  }
  var leftSuffix = left.length - 1
  var rightSuffix = right.length - 1
  while (leftSuffix >= prefix && rightSuffix >= prefix && left[leftSuffix] === right[rightSuffix]) {
    leftSuffix -= 1
    rightSuffix -= 1
  }
  var commonPrefix = left.slice(0, prefix)
  var commonSuffix = left.slice(leftSuffix + 1)
  return {
    left: [
      { type: 'same', text: commonPrefix },
      { type: 'removed', text: left.slice(prefix, leftSuffix + 1) },
      { type: 'same', text: commonSuffix },
    ].filter(function (segment) { return segment.text }),
    right: [
      { type: 'same', text: commonPrefix },
      { type: 'added', text: right.slice(prefix, rightSuffix + 1) },
      { type: 'same', text: commonSuffix },
    ].filter(function (segment) { return segment.text }),
  }
}

function buildHighlightedTextDiff(leftText, rightText) {
  var leftTokens = tokenizeDiffText(leftText)
  var rightTokens = tokenizeDiffText(rightText)
  if (leftTokens.length === 0 && rightTokens.length === 0) {
    return { left: [], right: [] }
  }
  if (leftTokens.length * rightTokens.length > 700000) {
    return buildSimpleTextDiff(leftText, rightText)
  }

  var table = Array(leftTokens.length + 1)
  for (var i = 0; i <= leftTokens.length; i += 1) {
    table[i] = new Uint16Array(rightTokens.length + 1)
  }
  for (var leftIndex = 1; leftIndex <= leftTokens.length; leftIndex += 1) {
    for (var rightIndex = 1; rightIndex <= rightTokens.length; rightIndex += 1) {
      if (leftTokens[leftIndex - 1] === rightTokens[rightIndex - 1]) {
        table[leftIndex][rightIndex] = table[leftIndex - 1][rightIndex - 1] + 1
      } else {
        table[leftIndex][rightIndex] = Math.max(table[leftIndex - 1][rightIndex], table[leftIndex][rightIndex - 1])
      }
    }
  }

  var operations = []
  var leftCursor = leftTokens.length
  var rightCursor = rightTokens.length
  while (leftCursor > 0 || rightCursor > 0) {
    if (leftCursor > 0 && rightCursor > 0 && leftTokens[leftCursor - 1] === rightTokens[rightCursor - 1]) {
      operations.push({ type: 'same', left: leftTokens[leftCursor - 1], right: rightTokens[rightCursor - 1] })
      leftCursor -= 1
      rightCursor -= 1
    } else if (rightCursor > 0 && (leftCursor === 0 || table[leftCursor][rightCursor - 1] >= table[leftCursor - 1][rightCursor])) {
      operations.push({ type: 'added', right: rightTokens[rightCursor - 1] })
      rightCursor -= 1
    } else {
      operations.push({ type: 'removed', left: leftTokens[leftCursor - 1] })
      leftCursor -= 1
    }
  }
  operations.reverse()

  var leftSegments = []
  var rightSegments = []
  operations.forEach(function (operation) {
    if (operation.type === 'same') {
      pushDiffSegment(leftSegments, 'same', operation.left)
      pushDiffSegment(rightSegments, 'same', operation.right)
    } else if (operation.type === 'removed') {
      pushDiffSegment(leftSegments, 'removed', operation.left)
    } else if (operation.type === 'added') {
      pushDiffSegment(rightSegments, 'added', operation.right)
    }
  })
  return { left: leftSegments, right: rightSegments }
}

function renderHighlightedText(segments, emptyText) {
  if (!segments || segments.length === 0) return emptyText || '无'
  return segments.map(function (segment, index) {
    var className = segment.type === 'same'
      ? 'manual-review-diff-segment'
      : 'manual-review-diff-segment manual-review-diff-segment-' + segment.type
    return (
      <span className={className} key={index}>
        {segment.text}
      </span>
    )
  })
}

function getDifferenceEditKey(fieldKey, itemIndex) {
  return fieldKey + '::difference::' + itemIndex
}

export default function BusinessManualReviewPanel({
  currentAlert,
  checkLabels,
  items,
  docInfo,
  currentPage,
  allDocs,
  manualDrafts,
  manualEditing,
  loading,
  saving,
  rerunning,
  locating,
  onDraftChange,
  onEditingChange,
  onJumpToPage,
  onSave,
  onRerun,
}) {
  var [differencePages, setDifferencePages] = useState({})
  if (!currentAlert) return null

  if (loading) {
    return (
      <aside className="manual-review-side">
        <strong>识别内容回填</strong>
        <p className="manual-review-muted">正在加载可编辑识别内容...</p>
      </aside>
    )
  }

  var scopedItems = filterManualReviewItemsForPreviewDoc(items || [], docInfo, currentPage, allDocs, currentAlert)
  if (scopedItems.length === 0) return null

  function setFieldEditing(item, field, editing) {
    var key = getManualReviewFieldKey(item, field)
    if (editing && isManualValueBlank(field.currentFieldValue) && !isManualValueBlank(field.originalFieldValue)) {
      var nextValue = buildManualReviewValueWithField(item, field, field.originalFieldValue, manualDrafts)
      onDraftChange(item.editable_id, stringifyManualReviewValue(nextValue))
    }
    onEditingChange(function (current) {
      var next = {}
      for (var existingKey in current) next[existingKey] = current[existingKey]
      if (editing) {
        next[key] = true
      } else {
        delete next[key]
      }
      return next
    })
  }

  function restoreFieldOriginal(item, field) {
    var nextValue = buildManualReviewValueWithField(item, field, field.originalFieldValue, manualDrafts)
    onDraftChange(item.editable_id, stringifyManualReviewValue(nextValue))
    setFieldEditing(item, field, true)
  }

  function handleFieldChange(item, field, value) {
    var nextFieldValue = parseManualFieldInput(value, field)
    var nextValue = buildManualReviewValueWithField(item, field, nextFieldValue, manualDrafts)
    onDraftChange(item.editable_id, stringifyManualReviewValue(nextValue))
  }

  function renderFieldInput(item, field, inputValue) {
    if (field.valueType === 'status') {
      var hasCurrentOption = MANUAL_REVIEW_STATUS_OPTIONS.some(function (option) {
        return option[0] === inputValue
      })
      return (
        <select
          value={inputValue}
          onChange={function (event) { handleFieldChange(item, field, event.target.value) }}
        >
          <option value="">请选择</option>
          {!hasCurrentOption && inputValue ? <option value={inputValue}>{inputValue}</option> : null}
          {MANUAL_REVIEW_STATUS_OPTIONS.map(function (option) {
            return <option value={option[0]} key={option[0]}>{option[1]}</option>
          })}
        </select>
      )
    }
    if (field.multiline || field.valueType === 'array') {
      return (
        <textarea
          value={inputValue}
          onChange={function (event) { handleFieldChange(item, field, event.target.value) }}
          rows={field.valueType === 'array' ? 3 : 2}
        />
      )
    }
    return (
      <input
        type="text"
        inputMode={field.valueType === 'amount' ? 'decimal' : undefined}
        value={inputValue}
        onChange={function (event) { handleFieldChange(item, field, event.target.value) }}
      />
    )
  }

  function setDifferencePage(fieldKey, nextPage, totalCount) {
    setDifferencePages(function (current) {
      var next = {}
      for (var key in current) next[key] = current[key]
      next[fieldKey] = Math.max(0, Math.min(nextPage, Math.max(0, totalCount - 1)))
      return next
    })
  }

  function setDifferenceEditing(fieldKey, itemIndex, editing, item, currentValue) {
    var editingKey = getDifferenceEditKey(fieldKey, itemIndex)
    if (editing && manualDrafts[item.editable_id] === undefined) {
      onDraftChange(
        item.editable_id,
        stringifyManualReviewValue(cloneStructuredValue(currentValue || item.original_value || {}))
      )
    }
    onEditingChange(function (current) {
      var next = {}
      for (var key in current) next[key] = current[key]
      if (editing) {
        next[editingKey] = true
      } else {
        delete next[editingKey]
      }
      return next
    })
  }

  function updateDifferenceBidText(item, currentValue, itemIndex, bidText, originalDiffItem) {
    var baseValue = getManualReviewCurrentValue(item, manualDrafts)
    if (!baseValue || typeof baseValue !== 'object' || Array.isArray(baseValue)) {
      baseValue = currentValue || item.original_value || {}
    }
    var nextValue = cloneStructuredValue(baseValue) || {}
    var nextItems = arrayify(nextValue.difference_items)
    if (nextItems.length === 0) {
      nextItems = arrayify(
        (currentValue && currentValue.difference_items) ||
        (item.original_value && item.original_value.difference_items)
      )
    }
    nextItems = nextItems.map(function (entry) {
      return entry && typeof entry === 'object' ? Object.assign({}, entry) : entry
    })
    while (nextItems.length <= itemIndex) nextItems.push({})
    nextItems[itemIndex] = Object.assign({}, nextItems[itemIndex] || {}, {
      bid_text: bidText,
      matched_text: bidText,
    })
    if (originalDiffItem && originalDiffItem.status && !nextItems[itemIndex].status) {
      nextItems[itemIndex].status = originalDiffItem.status
    }
    nextValue.difference_items = nextItems
    if (!nextValue.manual_status) {
      nextValue.manual_status = String(
        nextValue.consistency_status ||
        nextValue.status ||
        nextValue.result ||
        'unclear'
      ).trim().toLowerCase() || 'unclear'
    }
    onDraftChange(item.editable_id, stringifyManualReviewValue(nextValue))
  }

  function restoreDifferenceBidText(item, currentValue, itemIndex) {
    var originalDiffItem = arrayify(item && item.original_value && item.original_value.difference_items)[itemIndex] || {}
    updateDifferenceBidText(
      item,
      currentValue,
      itemIndex,
      getDifferenceItemText(originalDiffItem, ['bid_text', 'matched_text', 'ocr_text', 'current_text', 'recognized_text']),
      originalDiffItem
    )
  }

  function renderDifferenceField(itemRecord, fieldKey, field, currentValue) {
    if (field.differenceMode === 'template_pass') {
      return (
        <div className="manual-review-diff-card manual-review-diff-card-pass">
          <strong>已通过</strong>
          <div className="manual-review-diff-block manual-review-diff-block-pass">
            <span>检查结果</span>
            <p className="manual-review-diff-text">
              {templatePassMessage(field.currentFieldValue)}
            </p>
          </div>
        </div>
      )
    }

    var differenceItems = getDifferenceItems(field)
    if (differenceItems.length === 0) {
      return (
        <div className="manual-review-value-row manual-review-value-row-long">
          <span>内容</span>
          <strong>{formatManualReviewFieldDisplayValue(field.currentFieldValue, field, currentValue)}</strong>
        </div>
      )
    }

    var pageIndex = Math.max(0, Math.min(Number(differencePages[fieldKey] || 0), differenceItems.length - 1))
    var item = differenceItems[pageIndex] || {}
    var summary = item.summary || ''
    var isTemplateViolation = field.differenceMode === 'template_violation'
    var templateText = getDifferenceItemText(item, ['template_text', 'reference_text', 'original_text', 'expected_text'])
    var bidText = getDifferenceItemText(item, ['bid_text', 'matched_text', 'ocr_text', 'current_text', 'recognized_text'])
    var originalDiffItem = arrayify(itemRecord && itemRecord.original_value && itemRecord.original_value.difference_items)[pageIndex] || {}
    var originalBidText = getDifferenceItemText(originalDiffItem, ['bid_text', 'matched_text', 'ocr_text', 'current_text', 'recognized_text'])
    var differenceEditingKey = getDifferenceEditKey(fieldKey, pageIndex)
    var isDifferenceEditing = Boolean(manualEditing[differenceEditingKey])
    var highlightedDiff = buildHighlightedTextDiff(item.template_text || '', item.bid_text || '')
    return (
      <div className="manual-review-diff-pager">
        <div className="manual-review-diff-nav">
          <button
            type="button"
            className="manual-review-page-btn"
            disabled={pageIndex <= 0}
            onClick={function () { setDifferencePage(fieldKey, pageIndex - 1, differenceItems.length) }}
          >
            上一条
          </button>
          <span>{isTemplateViolation ? '问题' : '差异'} {pageIndex + 1}/{differenceItems.length}</span>
          <button
            type="button"
            className="manual-review-page-btn"
            disabled={pageIndex >= differenceItems.length - 1}
            onClick={function () { setDifferencePage(fieldKey, pageIndex + 1, differenceItems.length) }}
          >
            下一条
          </button>
        </div>
        <div className={isTemplateViolation ? 'manual-review-diff-card manual-review-diff-card-focused' : 'manual-review-diff-card'}>
          <strong>{item.label || (isTemplateViolation ? '固定模板内容被修改' : '文本差异')}</strong>
          {isTemplateViolation ? (
            <>
              <div className="manual-review-diff-block manual-review-diff-block-template">
                <span>原固定模板内容</span>
                <p className="manual-review-diff-text">
                  {renderPlainDifferenceText(templateText, '无对应模板内容')}
                </p>
              </div>
              <div className="manual-review-diff-block manual-review-diff-block-bid">
                <div className="manual-review-diff-block-head">
                  <span>投标识别内容（导致不通过）</span>
                  <div className="manual-review-diff-inline-actions">
                    <button
                      type="button"
                      className="manual-review-edit-btn"
                      onClick={function () { setDifferenceEditing(fieldKey, pageIndex, !isDifferenceEditing, itemRecord, currentValue) }}
                    >
                      {isDifferenceEditing ? '完成编辑' : '修改'}
                    </button>
                    <button
                      type="button"
                      className="manual-review-restore-btn"
                      disabled={isManualValueBlank(originalBidText)}
                      onClick={function () { restoreDifferenceBidText(itemRecord, currentValue, pageIndex) }}
                    >
                      恢复OCR
                    </button>
                  </div>
                </div>
                {isDifferenceEditing ? (
                  <label className="manual-review-input manual-review-diff-inline-editor">
                    <span>人工修正投标识别内容</span>
                    <textarea
                      value={bidText || ''}
                      rows={4}
                      onChange={function (event) {
                        updateDifferenceBidText(itemRecord, currentValue, pageIndex, event.target.value, originalDiffItem)
                      }}
                    />
                  </label>
                ) : (
                  <p className="manual-review-diff-text">
                    {renderPlainDifferenceText(bidText || summary, '未识别到对应投标内容')}
                  </p>
                )}
              </div>
            </>
          ) : item.template_text || item.bid_text ? (
            <>
              <div className="manual-review-diff-legend">
                <span><i className="manual-review-diff-legend-removed" />招标模板固定正文差异</span>
                <span><i className="manual-review-diff-legend-added" />投标 OCR 固定正文差异</span>
              </div>
              <div className="manual-review-diff-block">
                <span>招标模板（参与比对文本）</span>
                <p className="manual-review-diff-text">
                  {renderHighlightedText(highlightedDiff.left, '无')}
                </p>
              </div>
              <div className="manual-review-diff-block">
                <span>投标OCR（参与比对文本）</span>
                <p className="manual-review-diff-text">
                  {renderHighlightedText(highlightedDiff.right, '无')}
                </p>
              </div>
            </>
          ) : (
            <p>{summary || formatManualReviewFieldDisplayValue(field.currentFieldValue, field, currentValue)}</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <aside className="manual-review-side">
      <div className="manual-review-head">
        <div>
          <span className="alert-tag">识别内容回填</span>
          <strong>{checkLabels[currentAlert.subType] || currentAlert.subType}</strong>
        </div>
        <div className="manual-review-actions">
          <button type="button" className="ghost-button" disabled={saving || rerunning} onClick={onSave}>
            {saving ? '保存中...' : '保存本模块'}
          </button>
          <button type="button" className="primary-button" disabled={saving || rerunning} onClick={onRerun}>
            {rerunning ? '复审中...' : '保存并二次审查'}
          </button>
        </div>
      </div>
      <div className="manual-review-side-list">
        {scopedItems.map(function (item) {
          var currentValue = getManualReviewCurrentValue(item, manualDrafts)
          var fields = buildManualReviewDisplayFields(item, currentValue)
          return (
            <div className="manual-review-item" key={item.editable_id}>
              <div className="manual-review-item-head">
                <strong>{manualReviewItemLabel(item)}</strong>
                <span>{item.bidder_name || item.bidder_key || '投标人'}</span>
              </div>
              <div className="manual-review-meta">
                <span>{item.has_manual_value || manualDrafts[item.editable_id] !== undefined ? '已人工修正' : '未修正'}</span>
              </div>
              <div className="manual-review-field-list">
                {fields.map(function (field) {
                  var fieldKey = getManualReviewFieldKey(item, field)
                  var isEditing = Boolean(manualEditing[fieldKey])
                  var inputValue = stringifyManualFieldInput(field.currentFieldValue, field.valueType)
                  var longValueClass = field.multiline || field.readOnly ? ' manual-review-value-row-long' : ''
                  return (
                    <div className={field.readOnly ? 'manual-review-field manual-review-field-readonly' : 'manual-review-field'} key={fieldKey}>
                      <div className="manual-review-field-head">
                        <span>{field.label}</span>
                        {!field.readOnly ? (
                          <div className="manual-review-field-actions">
                          <button
                            type="button"
                            className="manual-review-edit-btn"
                            onClick={function () { setFieldEditing(item, field, !isEditing) }}
                          >
                            {isEditing ? '完成编辑' : '修改'}
                          </button>
                          {field.locateTarget === 'deadline' ? (
                            <button
                              type="button"
                              className="manual-review-locate-btn"
                              disabled={Boolean(locating)}
                              onClick={function () { onJumpToPage(item, field) }}
                            >
                              {locating ? '打开中...' : '定位日期'}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="manual-review-restore-btn"
                            disabled={isManualValueBlank(field.originalFieldValue)}
                            onClick={function () { restoreFieldOriginal(item, field) }}
                          >
                            恢复OCR
                          </button>
                          </div>
                        ) : null}
                      </div>
                      {field.valueType === 'difference_list' ? (
                        renderDifferenceField(item, fieldKey, field, currentValue)
                      ) : field.readOnly ? (
                        <div className={'manual-review-value-row' + longValueClass}>
                          <span>内容</span>
                          <strong>{formatManualReviewFieldDisplayValue(field.currentFieldValue, field, currentValue)}</strong>
                        </div>
                      ) : (
                        <>
                          <div className={'manual-review-value-row' + longValueClass}>
                            <span>OCR</span>
                            <strong>{formatManualReviewFieldDisplayValue(field.originalFieldValue, field, item.original_value)}</strong>
                          </div>
                          <div className={'manual-review-value-row' + longValueClass}>
                            <span>当前</span>
                            <strong>{formatManualReviewFieldDisplayValue(field.currentFieldValue, field, currentValue)}</strong>
                          </div>
                        </>
                      )}
                      {isEditing && !field.readOnly ? (
                        <label className="manual-review-input">
                          <span>人工修正</span>
                          {renderFieldInput(item, field, inputValue)}
                        </label>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
