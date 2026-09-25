import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

let helpers

before(async () => {
  const bundled = await build({
    stdin: {
      contents: `export { auditTypoIssues, auditTypoReview, auditTypoSpans } from './src/pages/ReviewPage.jsx';`,
      resolveDir: process.cwd(),
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
    plugins: [{
      name: 'test-export',
      setup(buildApi) {
        buildApi.onLoad({ filter: /\/ReviewPage\.jsx$/ }, async (args) => ({
          contents: await readFile(args.path, 'utf8') + '\nexport { getDuplicateTypoIssues as auditTypoIssues, getDuplicateTypoReviewCandidates as auditTypoReview, getTypoSpansForSource as auditTypoSpans };',
          loader: 'jsx',
        }))
      },
    }],
  })
  const source = Buffer.from(bundled.outputFiles[0].text).toString('base64')
  globalThis.window = {
    location: { origin: 'http://test.local' },
    sessionStorage: {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  }
  helpers = await import(`data:text/javascript;base64,${source}`)
})

test('only confirmed full-word issues display; historical character candidates stay hidden', () => {
  const alert = {
    evidence: {
      cluster: {
        short_duplicate_typo_issues: [
          { shared_id: 'confirmed', verification_status: 'confirmed', original_word: '培圳', replacement_word: '培训', matched_text: '培圳', suggestion: '培训', occurrences: [{ source_evidence_id: 'e1', side: 'left', start: 1, end: 2 }] },
          { matched_text: '性', suggestion: '新', page: 1 },
        ],
        typo_review_candidates: [
          { shared_id: 'review', verification_status: 'review', matched_text: '菜试', suggestion: '菜式', occurrences: [{ source_evidence_id: 'e1', side: 'left', start: 3, end: 4 }] },
        ],
      },
    },
  }
  assert.deepEqual(helpers.auditTypoIssues(alert).map((item) => item.shared_id), ['confirmed'])
  assert.deepEqual(helpers.auditTypoReview(alert), [])
})

test('highlight spans require the exact evidence and side and preserve code-point offsets', () => {
  const spans = helpers.auditTypoSpans([
    { verification_status: 'confirmed', occurrences: [
      { source_evidence_id: 'e1', side: 'left', start: 2, end: 3 },
      { source_evidence_id: 'e1', side: 'right', start: 4, end: 5 },
      { source_evidence_id: 'other', side: 'left', start: 6, end: 7 },
    ] },
  ], 'e1', 'left')
  assert.deepEqual(spans, [{ start: 2, end: 3, review: false }])
  assert.equal(Array.from('A😀性兼容性').slice(spans[0].start, spans[0].end).join(''), '性')
})
