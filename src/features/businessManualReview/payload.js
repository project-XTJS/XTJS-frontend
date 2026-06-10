import {
  areManualReviewValuesEqual,
  parseManualReviewValue,
} from './valueUtils'

export function buildManualReviewPayloadItems(items, manualDrafts) {
  return items.map(function (item) {
    var draftText = manualDrafts[item.editable_id]
    if (draftText === undefined) return null
    var manualValue = parseManualReviewValue(draftText, item.original_value)
    if (areManualReviewValuesEqual(manualValue, item.original_value)) {
      if (!item.has_manual_value) return null
      return Object.assign({}, item, { manual_value: null, updated_at: new Date().toISOString() })
    }
    return Object.assign({}, item, { manual_value: manualValue, updated_at: new Date().toISOString() })
  }).filter(Boolean)
}

