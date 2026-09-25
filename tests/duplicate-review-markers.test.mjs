import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

let helpers

before(async () => {
  const bundled = await build({
    stdin: {
      contents: "export { auditRects, auditPageRects, auditEvidenceRows, auditClusterDocs, auditAlerts, auditOccurrenceEntries } from './src/pages/ReviewPage.jsx';",
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
          contents: await readFile(args.path, 'utf8') +
            '\nexport { collectHighlightRects as auditRects, mergeHighlightPageRects as auditPageRects, buildDuplicateEvidenceRows as auditEvidenceRows, buildDuplicateClusterDocs as auditClusterDocs, collectDuplicateAlerts as auditAlerts, getDuplicateOccurrenceDocEntries as auditOccurrenceEntries };',
          loader: 'jsx',
        }))
      },
    }],
  })
  globalThis.window = { location: { origin: 'http://test.local' }, sessionStorage: {
    length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {},
  } }
  helpers = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
})

test('one physical rectangle is drawn once while distinct pages remain marked', () => {
  const box = [10, 20, 50, 60]
  assert.deepEqual(helpers.auditRects([box, box, [12, 20, 50, 60]]), [box, [12, 20, 50, 60]])
  const pageRects = helpers.auditPageRects(
    [{ page: 1, rect: box }],
    [{ page: 1, rect: box }, { page: 2, rect: box }],
  )
  assert.deepEqual(pageRects, [{ page: 1, rect: box }, { page: 2, rect: box }])
})

test('grouped source evidence is shown once but remains traceable', () => {
  const evidence = { left_text: '内存不少于64GB', right_text: '内存不少于64GB' }
  const cluster = { files: ['A.pdf', 'B.pdf'], occurrences: [{
    kind: 'block', docs: { 'A.pdf': { pages: [1] }, 'B.pdf': { pages: [2] } }, evidence,
    source_evidence: [{ kind: 'block', evidence }, { kind: 'table', evidence }],
  }] }
  const rows = helpers.auditEvidenceRows(cluster)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source_evidence_count, 2)
  assert.deepEqual(rows[0].source_kinds, ['block', 'table'])
  assert.equal(rows[0].source_evidence.length, 2)
})

test('a separate rectangle remains available on each real page', () => {
  const location = (page) => ({ file_name: 'A.pdf', document_identifier_id: 'document-A', page, bbox: [10, 20, 50, 60], text: '内存不少于64GB' })
  const docs = helpers.auditClusterDocs({
    files: ['A.pdf'], locations: [location(1), location(1), location(3)],
    doc_ranges_by_file: { 'A.pdf': [{ start_page: 1, end_page: 3 }] },
  })
  assert.equal(docs.length, 1)
  assert.deepEqual(docs[0].highlightPageRects.map((item) => item.page), [1, 3])
})

test('a group review ID remains stable when its page position changes', () => {
  const group = { cluster_id: 'dupgroup-stable', risk_level: 'high', status: 'failed',
    files: ['A.pdf', 'B.pdf'], occurrence_count: 1, locations: [] }
  const first = []
  const second = []
  helpers.auditAlerts({ technical_bid_duplicate_check: { issues: [group] } }, first)
  helpers.auditAlerts({ technical_bid_duplicate_check: { issues: [
    { ...group, cluster_id: 'other' }, group,
  ] } }, second)
  assert.equal(first[0].id, 'dupgroup-stable')
  assert.equal(second[1].id, 'dupgroup-stable')
  assert.equal(second[1].reviewIssueId, 'dupgroup-stable')
})

test('two documents with the same filename keep separate preview locations', () => {
  const docs = helpers.auditClusterDocs({
    files: ['投标文件.pdf'], locations: [
      { file_name: '投标文件.pdf', document_identifier_id: 'bidder-A', page: 1, bbox: [1, 2, 10, 20], text: 'A' },
      { file_name: '投标文件.pdf', document_identifier_id: 'bidder-B', page: 4, bbox: [1, 2, 10, 20], text: 'B' },
    ],
  })
  assert.equal(docs.length, 2)
  assert.deepEqual(new Set(docs.map((doc) => doc.docId)), new Set(['bidder-A', 'bidder-B']))
  assert.deepEqual(new Set(docs.map((doc) => doc.highlightPageRects[0].page)), new Set([1, 4]))
  const entries = helpers.auditOccurrenceEntries({ files: ['投标文件.pdf'] }, {
    left_file_name: '投标文件.pdf', right_file_name: '投标文件.pdf',
    left_document_identifier_id: 'bidder-A', right_document_identifier_id: 'bidder-B',
    docs: { '投标文件.pdf': { pages: [1] } },
    evidence: { left_pages: [1], right_pages: [4] },
  })
  assert.deepEqual(entries.map((entry) => entry.doc.document_identifier_id), ['bidder-A', 'bidder-B'])
  assert.deepEqual(entries.map((entry) => entry.doc.pages), [[1], [4]])
})
