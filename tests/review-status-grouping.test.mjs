import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

let helpers

before(async () => {
  const bundled = await build({
    stdin: {
      contents: `export { auditCounts, auditFilter, auditLabel, auditClass, auditNote, auditRemovedScopeIssue, auditOptionalIssue, auditCollect, auditCleanIntegritySummary } from './src/pages/ReviewPage.jsx';`,
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
          contents: await readFile(args.path, 'utf8') + `
export {
  getReviewResultFilterCounts as auditCounts,
  filterReviewAlertsByResult as auditFilter,
  getReviewResultLabel as auditLabel,
  getReviewResultClass as auditClass,
  getReviewResultAnalysisNote as auditNote,
  isRemovedBusinessScopeIssue as auditRemovedScopeIssue,
  isOptionalBusinessReviewIssue as auditOptionalIssue,
  collectFormatReviewAlerts as auditCollect,
  cleanBusinessIntegritySummary as auditCleanIntegritySummary,
};`,
          loader: 'jsx',
        }))
      },
    }],
  })
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
  const source = Buffer.from(bundled.outputFiles[0].text).toString('base64')
  helpers = await import(`data:text/javascript;base64,${source}`)
})

test('待复核和不适用归入不通过但保留具体分析说明', () => {
  const alerts = [
    { id: 'pass', sourceStatus: 'pass' },
    { id: 'fail', sourceStatus: 'fail' },
    { id: 'unclear', sourceStatus: 'unclear' },
    { id: 'not-applicable', sourceStatus: 'not_applicable' },
    { id: 'skipped', sourceStatus: 'skipped' },
    { id: 'optional', sourceStatus: 'optional' },
  ]

  assert.deepEqual(helpers.auditCounts(alerts), { all: 6, pass: 1, fail: 5 })
  assert.deepEqual(
    helpers.auditFilter(alerts, 'fail').map((item) => item.id),
    ['fail', 'unclear', 'not-applicable', 'skipped', 'optional'],
  )
  assert.equal(helpers.auditLabel(alerts[2]), '不通过')
  assert.equal(helpers.auditClass(alerts[2]), 'result-fail')
  assert.equal(helpers.auditLabel(alerts[3]), '不通过')
  assert.equal(helpers.auditClass(alerts[3]), 'result-fail')
  assert.match(helpers.auditNote(alerts[2]), /人工复核/)
  assert.match(helpers.auditNote(alerts[3]), /不适用/)
})

test('退役的商务材料范围诊断不再展示', () => {
  assert.equal(helpers.auditRemovedScopeIssue({ title: '商务材料组成范围待确认' }), true)
  assert.equal(helpers.auditRemovedScopeIssue({ title: '营业执照' }), false)
  assert.equal(
    helpers.auditCleanIntegritySummary(
      'integrity_check',
      '共提取 3 项，实际校验 3 项，已命中 3/3 项。 商务材料组成范围待确认。',
    ),
    '共提取 3 项，实际校验 3 项，已命中 3/3 项。',
  )
})

test('可选材料从全部商务审查结果中排除', () => {
  assert.equal(helpers.auditOptionalIssue({
    title: '附件13 残疾人福利性单位声明函（格式）',
    evidence: { is_optional: true },
  }), true)
  assert.equal(helpers.auditOptionalIssue({
    title: '分项报价表（不项目不适用）',
  }), true)

  const alerts = []
  helpers.auditCollect({}, alerts, {
    result: {
      bidders: [{
        bidder_key: 'bidder-1',
        checks: {
          integrity_check: {
            check_name: '商务标完整性审查',
            review: { status: 'fail', summary: '存在缺失项' },
            issues: {
              missing: [{
                title: '附件13 残疾人福利性单位声明函（格式）',
                evidence: { is_optional: true },
              }],
            },
          },
          consistency_check: {
            check_name: '模板一致性审查',
            review: { status: 'fail', summary: '存在不一致项' },
            issues: {
              failed: [{
                title: '附件13 残疾人福利性单位声明函（格式）',
                evidence: {},
              }],
            },
          },
          verification_check: {
            check_name: '签字盖章日期审查',
            review: { status: 'pass', summary: '检查通过' },
            issues: {
              passed: [{
                title: '附件13 残疾人福利性单位声明函（格式）',
                evidence: {},
              }],
            },
          },
        },
      }],
    },
  })
  assert.equal(alerts.length, 0)
})
