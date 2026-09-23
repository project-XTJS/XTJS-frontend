import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

let browser, server, origin
before(async () => {
  server = createServer(async (request, response) => {
    try {
      const path = request.url === '/' ? '/index.html' : request.url
      const data = await readFile(new URL(`../dist${path}`, import.meta.url))
      response.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html')
      response.end(data)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
})
after(async () => {
  await browser?.close()
  await new Promise((resolve) => server?.close(resolve))
})

const projects = Array.from({ length: 15 }, (_, index) => ({
  identifier_id: `project-${index + 1}`, project_name: `测试项目 ${index + 1}`,
  parsing_status: 3, relation_count: 3,
  available_result_keys: ['business_bid_format_review'],
  result_summary: { version: 1, result_count: 2, has_suspicious: false,
    result_keys: ['business_bid_format_review', 'deviation_check'] },
}))
const detail = (project) => ({ project, relations: [{
  relation_id: 1, tender_identifier_id: 'tender', tender_file_name: '招标.pdf',
  business_bid_identifier_id: 'business', business_bid_file_name: `${project.project_name}-商务.pdf`,
  technical_bid_identifier_id: 'technical', technical_bid_file_name: '技术.pdf',
}] })
const reviewSummary = (project, changes = {}) => ({
  project: {
    identifier_id: project.identifier_id,
    project_name: project.project_name,
    parsing_status: project.parsing_status,
    input_revision: changes.input_revision ?? 1,
  },
  result_version: changes.result_version ?? null,
  status: changes.status ?? 'legacy',
  results_stale: changes.results_stale ?? false,
  compatibility_mode: changes.compatibility_mode ?? true,
  issue_count: changes.issue_count ?? 2,
  risk_counts: changes.risk_counts ?? { high: 1, medium: 0, low: 0, none: 1 },
  categories: changes.categories ?? [
    { result_key: 'business_bid_format_review', status: 'legacy', issue_count: 2, risk_counts: { high: 1, none: 1 } },
    { result_key: 'deviation_check', status: 'legacy', issue_count: 0, risk_counts: {} },
  ],
})
const fulfill = (route, data, status = 200) => route.fulfill({ status, json: { code: status, message: status === 200 ? 'success' : '测试加载失败', data } })

for (const succeeds of [true, false]) {
  test(`单文件替换${succeeds ? '成功后更新文件' : '失败后保留原文件'}`, async (t) => {
    let replaced = false, pending, requestBody
    const item = { ...projects[0], parsing_status: 2 }
    const { page } = await pageWithApi(t, async (route, path) => {
      if (path.endsWith('/replace-document')) {
        pending = route
        requestBody = route.request().postData()
        return true
      }
      if (path.endsWith('/ocr-status')) {
        return fulfill(route, { is_queued: false, ocr_progress: { active: [], stages: [{ stage: 'technical', total_count: 1,
          completed_count: replaced ? 1 : 0, completed_documents: replaced ? [{ identifier_id: 'new', file_name: '新技术.pdf' }] : [],
          pending_documents: replaced ? [] : [{ identifier_id: 'technical', file_name: '技术.pdf' }] }] } }).then(() => true)
      }
      return false
    }, [item])
    const input = page.getByLabel('替换 技术.pdf', { exact: true })
    await input.waitFor({ state: 'attached' })
    await input.setInputFiles({ name: '新技术.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') })
    await page.getByText('替换中…', { exact: true }).waitFor()
    assert.ok(await input.isDisabled())
    while (!pending) await new Promise(resolve => setTimeout(resolve, 10))
    assert.match(requestBody, /technical_bid/)
    assert.match(requestBody, /technical/)
    replaced = succeeds
    await fulfill(pending, succeeds ? detail({ ...item, parsing_status: 3 }) : null, succeeds ? 200 : 400)
    if (succeeds) {
      await page.getByText(/已识别并替换成功/).waitFor()
      await page.getByLabel('替换 新技术.pdf', { exact: true }).waitFor({ state: 'attached' })
    } else {
      await page.getByText(/替换未确认完成/).waitFor()
      assert.equal(await page.getByLabel('替换 技术.pdf', { exact: true }).count(), 1)
    }
  })
}

test('替换过程中切换项目，迟到响应不覆盖当前项目', async (t) => {
  let pending
  const { page } = await pageWithApi(t, async (route, path) => {
    if (path.endsWith('/replace-document')) { pending = route; return true }
    if (path.endsWith('/ocr-status')) {
      return fulfill(route, { ocr_progress: { active: [], stages: [{ stage: 'technical', total_count: 1, completed_count: 0,
        pending_documents: [{ identifier_id: 'technical', file_name: '技术.pdf' }] }] } }).then(() => true)
    }
    return false
  }, projects.slice(0, 2))
  await page.getByLabel('替换 技术.pdf', { exact: true }).setInputFiles({ name: '新技术.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })
  await page.getByText('替换中…', { exact: true }).waitFor()
  await page.locator('.project-card').nth(1).click()
  await page.locator('.project-card.is-active').getByText('测试项目 2', { exact: true }).waitFor()
  while (!pending) await new Promise(resolve => setTimeout(resolve, 10))
  await fulfill(pending, detail(projects[0]))
  await page.waitForFunction(() => !document.body.innerText.includes('替换中…'))
  assert.match(await page.locator('.project-card.is-active').innerText(), /测试项目 2/)
  assert.equal(await page.getByText(/已识别并替换成功/).count(), 0)
})

test('上传不完整优先显示，禁止把已完成的部分当作完整项目', async (t) => {
  const item = { ...projects[0], upload_complete: false,
    upload_issues: [{ slot: 'technical_bid:1', company: '测试公司', name: '技术标.pdf', status: 'failed' }] }
  const { page, requests } = await pageWithApi(t, undefined, [item])
  await page.getByText('上传不完整，请补齐以下材料后继续检查').waitFor()
  assert.match(await page.locator('.project-card').first().innerText(), /上传不完整/)
  assert.equal(await page.getByRole('link', { name: '进入分析中心 →' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '重新生成商务审查' }).count(), 0)
  assert.equal(await page.getByLabel('补传 技术标.pdf').count(), 1)
  assert.ok(!requests.some((path) => path.endsWith('/workflow-state')))
})

test('补传成功后清除失败提示，保留手动继续检查流程', async (t) => {
  const item = { ...projects[0], upload_complete: false,
    upload_issues: [{ slot: 'technical_bid:1', company: '测试公司', name: '技术标.pdf', status: 'failed' }] }
  let repaired = false
  const { page } = await pageWithApi(t, async (route, path) => {
    if (path.endsWith('/upload-missing')) {
      repaired = true
      await fulfill(route, detail({ ...item, upload_complete: true, upload_issues: [] }))
      return true
    }
    if (repaired && path.endsWith('/project-1')) {
      await fulfill(route, detail({ ...item, upload_complete: true, upload_issues: [] }))
      return true
    }
    return false
  }, [item])
  await page.getByLabel('补传 技术标.pdf').setInputFiles({ name: '技术标.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-fixture') })
  await page.getByText('项目材料已补齐，可以手动继续 OCR。', { exact: true }).waitFor()
  assert.equal(await page.getByText('上传不完整，请补齐以下材料后继续检查').count(), 0)
})

async function pageWithApi(t, intercept = async () => false, items = projects, seedLegacyCache = false) {
  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  const requests = []
  await page.addInitScript(() => localStorage.setItem('xtjs-auth-token', 'mock-browser-test'))
  if (seedLegacyCache) {
    await page.addInitScript(() => {
      const key = 'xtjs-api-cache:' + window.location.origin + '/api/postgresql/projects?page=1&page_size=24'
      sessionStorage.setItem(key, JSON.stringify({ expiresAt: Date.now() + 30000,
        payload: { items: [{ identifier_id: 'old', project_name: '旧版缓存项目', parsing_status: 3 }] } }))
      sessionStorage.setItem('xtjs-api-cache:legacy-full-result', 'x'.repeat(300 * 1024))
    })
  }
  await page.route('**/health', (route) => fulfill(route, { status: 'healthy' }))
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    requests.push(path)
    if (await intercept(route, path)) return
    if (path === '/api/auth/me') return fulfill(route, { username: 'test', role_level: 4 })
    if (path === '/api/postgresql/projects') return fulfill(route, { items })
    if (path.endsWith('/ocr-status')) return fulfill(route, {})
    if (path.endsWith('/workflow-state')) return fulfill(route, { excluded_bidders: [] })
    if (path.endsWith('/business-review/tasks/latest')) return fulfill(route, null)
    const summaryProject = items.find((item) => path === `/api/postgresql/projects/${item.identifier_id}/review/summary`)
    if (summaryProject) return fulfill(route, reviewSummary(summaryProject))
    const project = items.find((item) => path === `/api/postgresql/projects/${item.identifier_id}`)
    if (project) return fulfill(route, detail(project))
    return fulfill(route, {}, 404)
  })
  await page.goto(`${origin}/#/projects`)
  return { page, requests }
}

test('列表先显示全部摘要，只请求选中项目详情，不读取分析结果', async (t) => {
  let pending
  const { page, requests } = await pageWithApi(t, async (route, path) => {
    if (path.endsWith('/project-1')) { pending = route; return true }
    return false
  })
  await page.locator('.project-card').nth(14).waitFor()
  assert.equal(await page.locator('.project-card').count(), 15)
  assert.match(await page.locator('.project-card').first().innerText(), /3 组标书/)
  assert.match(await page.locator('.project-card').first().innerText(), /已完成/)
  await page.getByText('正在加载项目详情...', { exact: true }).waitFor()
  assert.ok(!requests.some((path) => /\/results|\/workflow-state/.test(path)))
  assert.equal(requests.filter((path) => /\/project-\d+$/.test(path)).length, 1)
  await fulfill(pending, detail(projects[0]))
  await page.locator('.relation-card').waitFor()
})

test('快速切换项目后，较晚返回的旧详情不会覆盖当前项目', async (t) => {
  let pending
  const { page, requests } = await pageWithApi(t, async (route, path) => {
    if (path.endsWith('/project-1')) { pending = route; return true }
    return false
  })
  await page.getByText('正在加载项目详情...', { exact: true }).waitFor()
  await page.locator('.project-card').nth(1).click()
  await page.getByText('测试项目 2-商务.pdf', { exact: true }).waitFor()
  await fulfill(pending, detail(projects[0]))
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.summary-head h2').innerText(), '测试项目 2')
  assert.equal(await page.getByText('测试项目 1-商务.pdf', { exact: true }).count(), 0)
  assert.ok(!requests.some((path) => path.endsWith('/results')))
})

test('详情失败保留列表，重试后恢复文档与操作', async (t) => {
  let failed = false
  const { page } = await pageWithApi(t, async (route, path) => {
    if (path.endsWith('/project-1') && !failed) {
      failed = true
      await fulfill(route, {}, 503)
      return true
    }
    return false
  })
  await page.getByRole('button', { name: '重试加载' }).waitFor()
  assert.equal(await page.locator('.project-card').count(), 15)
  assert.equal(await page.getByRole('button', { name: '重新生成商务审查' }).count(), 0)
  await page.getByRole('button', { name: '重试加载' }).click()
  await page.locator('.relation-card').waitFor()
  await page.getByRole('button', { name: '重新生成商务审查' }).waitFor()
})

test('商务审查首次点击后持续锁定，刷新后恢复，仅在终态解锁', async (t) => {
  let submitCount = 0
  let taskStatus = 'queued'
  const task = () => ({
    task_id: 'business-task-lock-test',
    project_identifier_id: 'project-1',
    request_id: 'business-request-lock-test',
    input_revision: 1,
    status: taskStatus,
    stage: taskStatus === 'running' ? 'reviewing' : taskStatus,
    progress: { completed: taskStatus === 'failed' ? 1 : 0, total: 1, message: '锁定测试' },
    error: taskStatus === 'failed' ? '测试任务已失败' : null,
  })
  const { page } = await pageWithApi(t, async (route, path) => {
    if (path.endsWith('/business-review/tasks/latest')) {
      await fulfill(route, submitCount ? task() : null)
      return true
    }
    if (path.endsWith('/business-review/tasks') && route.request().method() === 'POST') {
      submitCount += 1
      await fulfill(route, task(), 202)
      return true
    }
    if (path.endsWith('/business-review/tasks/business-task-lock-test')) {
      await fulfill(route, task())
      return true
    }
    return false
  }, projects.slice(0, 1))

  const readyButton = page.getByRole('button', { name: '重新生成商务审查' })
  await readyButton.waitFor()
  await readyButton.click()
  const queuedButton = page.getByRole('button', { name: '排队中' })
  await queuedButton.waitFor()
  assert.equal(await queuedButton.isDisabled(), true)
  await queuedButton.click({ force: true })
  assert.equal(submitCount, 1)

  await page.reload()
  const restoredButton = page.getByRole('button', { name: '排队中' })
  await restoredButton.waitFor()
  assert.equal(await restoredButton.isDisabled(), true)
  assert.equal(submitCount, 1)

  taskStatus = 'failed'
  await readyButton.waitFor({ timeout: 6000 })
  assert.equal(await readyButton.isEnabled(), true)
  assert.equal(submitCount, 1)
})

test('已保存的技术标剔除范围返回前禁止操作，返回后保留剔除项', async (t) => {
  let pending
  const items = [{ ...projects[0], parsing_status: 2 }]
  const { page } = await pageWithApi(t, async (route, path) => {
    if (path.endsWith('/workflow-state')) { pending = route; return true }
    return false
  }, items)
  const checkbox = page.locator('.technical-ocr-candidate input')
  await checkbox.waitFor()
  assert.equal(await checkbox.isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '继续技术标 OCR' }).isDisabled(), true)
  await fulfill(pending, { excluded_bidders: [{ technical_bid_document_id: 'technical' }] })
  await page.getByText('已选择 0 / 1 份技术标参与 OCR', { exact: true }).waitFor()
  assert.equal(await checkbox.isChecked(), false)
  assert.equal(await checkbox.isDisabled(), false)
  assert.equal(await page.getByRole('button', { name: '继续技术标 OCR' }).isDisabled(), true)
})

test('详情超时给出重试入口，OCR 请求缓慢时不堆积轮询', async (t) => {
  let detailRoute
  let ocrRequests = 0
  const { page } = await pageWithApi(t, async (route, path) => {
    if (path.endsWith('/project-1')) { detailRoute = route; return true }
    if (path.endsWith('/ocr-status')) { ocrRequests += 1; return true }
    return false
  }, [{ ...projects[0], parsing_status: 1 }])
  await page.getByText('正在加载项目详情...', { exact: true }).waitFor()
  // 使用真实浏览器计时覆盖 AbortController 和 fetch 等待中的超时。
  await page.getByText('加载超时，请稍后重试。', { exact: true }).waitFor({ timeout: 25000 })
  assert.equal(ocrRequests, 1)
  assert.ok(detailRoute)
  await page.getByRole('button', { name: '重试加载' }).waitFor()
})

test('摘要区分风险、完成与待分析，长标题不会挤压状态标签换行', async (t) => {
  const items = projects.slice(0, 3).map((project, index) => ({
    ...project,
    project_name: `${project.project_name} 响应文件 XTJS2026-249 10000小时UMI数据采购`,
    result_summary: { ...project.result_summary, has_suspicious: index === 0,
      result_count: index === 2 ? 0 : 2, result_keys: index === 2 ? [] : project.result_summary.result_keys },
  }))
  const { page, requests } = await pageWithApi(t, async () => false, items)
  await page.locator('.project-card').nth(2).waitFor()
  assert.deepEqual(await page.locator('.project-card .status-pill').allTextContents(), ['需复核', '已完成', '待分析'])
  assert.ok(!requests.some((path) => path.endsWith('/results')))
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    const badges = await page.locator('.project-card .status-pill').evaluateAll((elements) => elements.map((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return { lines: range.getClientRects().length, whiteSpace: getComputedStyle(element).whiteSpace,
        right: element.getBoundingClientRect().right, cardRight: element.closest('.project-card').getBoundingClientRect().right }
    }))
    for (const badge of badges) {
      assert.equal(badge.lines, 1)
      assert.equal(badge.whiteSpace, 'nowrap')
      assert.ok(badge.right <= badge.cardRight)
    }
  }
})

test('升级后不复用缺少状态摘要的旧版列表缓存', async (t) => {
  const { page, requests } = await pageWithApi(t, async () => false, projects, true)
  await page.locator('.project-card').nth(14).waitFor()
  assert.equal(await page.getByText('旧版缓存项目', { exact: true }).count(), 0)
  assert.equal(requests.filter((path) => path === '/api/postgresql/projects').length, 1)
  assert.match(await page.locator('.project-card').first().innerText(), /已完成/)
  assert.equal(await page.evaluate(() => sessionStorage.getItem('xtjs-api-cache:legacy-full-result')), null)
})

const reviewFixture = { business_bid_format_review: { bidders: [{ bidder_key: 'a-company', bidder_name: '项目A公司', checks: { verification_check: { issues: { failed: [{ title: '项目A专属签章问题', status: 'fail', message: '项目A内容', severity: 'error' }] } } } }] } }

test('结果审核切项目失败时清空旧结果并禁止导出，重试后恢复', async (t) => {
  let fail = true
  const { page } = await pageWithApi(t, async (route, path) => {
    if (path.endsWith('/project-1/results')) { await fulfill(route, { results: reviewFixture, input_revision: 1 }); return true }
    if (path.endsWith('/project-2/review/summary')) { await fulfill(route, reviewSummary(projects[1], { input_revision: 2 }), fail ? 503 : 200); return true }
    if (path.endsWith('/project-2/results')) { await fulfill(route, { results: {}, input_revision: 2 }); return true }
    if (path.includes('/format-review/editable')) { await fulfill(route, { items: [] }); return true }
    return false
  }, projects.slice(0,2))
  await page.goto(`${origin}/#/review?projectId=project-1`)
  await page.getByRole('heading', { name: '项目级审查总览' }).waitFor()
  await page.locator('.project-dropdown-trigger').click()
  await page.locator('.dropdown-item').filter({ hasText: '测试项目 2' }).click()
  await page.getByRole('button', { name: '重试加载结果' }).waitFor()
  assert.equal(await page.getByText('项目A专属签章问题').count(),0)
  assert.equal(await page.getByRole('button', { name: /^导出报告/ }).isEnabled(),false)
  fail = false
  await page.getByRole('button', { name: '重试加载结果' }).click()
  await page.getByRole('heading', { name: '项目级审查总览' }).waitFor()
  await page.locator('.filter-card').filter({ hasText: '商务标形式审查' }).click()
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((item) => /^导出报告/.test(item.textContent || ''))
    return button && !button.disabled
  })
  assert.equal(await page.getByRole('button', { name: /^导出报告/ }).isEnabled(),true)
})

test('结果审核迟到的旧项目响应不会覆盖当前项目', async (t) => {
  let oldRequest
  const { page } = await pageWithApi(t, async (route,path) => {
    if (path.endsWith('/project-1/review/summary')) { oldRequest=route; return true }
    return false
  },projects.slice(0,2))
  await page.goto(`${origin}/#/review?projectId=project-1`)
  await page.locator('.project-dropdown-trigger').click()
  await page.locator('.dropdown-item').filter({hasText:'测试项目 2'}).click()
  await page.getByRole('heading',{name:'项目级审查总览'}).waitFor()
  assert.ok(oldRequest)
  await fulfill(oldRequest,reviewSummary(projects[0]))
  await page.waitForTimeout(100)
  assert.equal(await page.getByText('项目A专属签章问题').count(),0)
  assert.match(await page.locator('.review-main').innerText(),/测试项目 2/)
})

test('材料变更后旧结果标记过期并禁止导出', async (t) => {
  const { page } = await pageWithApi(t,async(route,path)=>{
    if(path.endsWith('/review/summary')){await fulfill(route,reviewSummary(projects[0],{results_stale:true,status:'stale',input_revision:3}));return true}
    return false
  },projects.slice(0,1))
  await page.goto(`${origin}/#/review?projectId=project-1`)
  await page.getByText('材料已变更，旧结果已过期，请到分析中心重新检查。').waitFor()
  assert.equal(await page.getByRole('button',{name:/^导出报告/}).isEnabled(),false)
})

const failedOcr = (active = [], queued = false) => ({ is_queued: queued, ocr_progress: { active, stages: [{
  stage: 'technical', required_parsing_status: 3, total_count: 2, completed_count: 1,
  completed_documents: [{ identifier_id: 'done', file_name: '已完成.pdf' }],
  pending_documents: [{ identifier_id: 'technical', file_name: '技术.pdf', ocr_last_error: {
    code: 'invalid_pdf', message: 'PDF 无法解析，请替换有效 PDF。', failed_at: '2026-09-15T05:37:27Z',
  } }],
}] } })

test('OCR 失败显示原因且继续任务立即结束等待，刷新后仍保留失败', async (t) => {
  let continued = false
  const { page } = await pageWithApi(t, async (route, path) => {
    if (path.endsWith('/ocr-status')) { await fulfill(route, failedOcr()); return true }
    if (path.endsWith('/workflow-scope')) { await fulfill(route, {}); return true }
    if (path.endsWith('/continue-technical-ocr')) { continued = true; await fulfill(route, { is_queued: true }); return true }
    return false
  }, [{ ...projects[0], parsing_status: 2 }])
  await page.locator('.ocr-file-failed').getByText('识别失败', { exact: true }).waitFor()
  assert.match(await page.locator('.ocr-file-error').innerText(), /PDF 无法解析/)
  assert.match(await page.locator('.summary-head .status-pill').innerText(), /识别失败待处理/)
  assert.equal(await page.locator('.ocr-file-done').count(), 1)
  const retry = page.getByRole('button', { name: '继续技术标 OCR', exact: true })
  await retry.click()
  await page.getByText(/技术标 OCR未完成：/).waitFor({ timeout: 10000 })
  assert.ok(continued)
  assert.equal(await retry.isEnabled(), true)
  assert.equal(await page.getByLabel('替换 技术.pdf', { exact: true }).isEnabled(), true)
  await page.reload()
  await page.locator('.ocr-file-error').getByText(/PDF 无法解析/).waitFor()
})

test('失败文件重试时显示实时进度，成功后移除错误；不会把旧错误带到另一个项目', async (t) => {
  let mode = 'active'
  const { page } = await pageWithApi(t, async (route, path) => {
    if (!path.endsWith('/ocr-status')) return false
    let data = failedOcr([{ document_id: 'technical', total_pages: 10, current_page: 2, percent: 20 }], true)
    if (mode === 'done') data = { is_queued: false, ocr_progress: { active: [], stages: [{ stage: 'technical', total_count: 1, completed_count: 1,
      completed_documents: [{ identifier_id: 'technical', file_name: '技术.pdf' }], pending_documents: [] }] } }
    if (path.includes('/project-2/')) data = {}
    await fulfill(route, data)
    return true
  }, projects.slice(0, 2).map(item => ({ ...item, parsing_status: 2 })))
  await page.locator('.ocr-file-active').waitFor()
  assert.equal(await page.locator('.ocr-file-failed').count(), 0)
  assert.equal(await page.getByLabel('替换 技术.pdf', { exact: true }).isEnabled(), false)
  mode = 'done'
  await page.locator('.ocr-file-active').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.ocr-file-error').count(), 0)
  await page.locator('.project-card').nth(1).click()
  await page.locator('.project-card.is-active').getByText('测试项目 2', { exact: true }).waitFor()
  assert.equal(await page.locator('.ocr-file-error').count(), 0)
})

test('OCR 状态请求失败显示提示，不静默当作没有任务', async (t) => {
  const { page } = await pageWithApi(t, async (route, path) => {
    if (path.endsWith('/ocr-status')) { await fulfill(route, null, 503); return true }
    return false
  }, [{ ...projects[0], parsing_status: 2 }])
  await page.getByRole('alert').getByText(/OCR 状态获取失败/).waitFor()
})

for (const onlyFailed of [false,true]) {
 test(`总览${onlyFailed ? '全部不通过' : '全部'}按条目跳转并返回原滚动位置`, async(t)=>{
  const fixture={business_bid_format_review:{bidders:[{bidder_key:'fixture',bidder_identity:{status:'resolved',name:'测试单位有限公司'},checks:{verification_check:{issues:{failed:Array.from({length:45},(_,i)=>({title:`待核条目 ${i+1}`,status:'fail',message:`原文依据 ${i+1}`,severity:'error'})),passed:[{title:'正常条目',status:'pass',message:'通过'}]}}}}]}}
  const {page}=await pageWithApi(t,async(route,path)=>{
   if(path.endsWith('/results')){await fulfill(route,{results:fixture,input_revision:1});return true}
   if(path.includes('/format-review/editable')){await fulfill(route,{items:[]});return true}
   return false
  },projects.slice(0,1))
  await page.goto(`${origin}/#/review?projectId=project-1`)
  await page.getByRole('heading',{name:'项目级审查总览'}).waitFor()
  await page.locator('.filter-card').filter({hasText:'商务标形式审查'}).click()
  await page.locator('.detail-container').waitFor()
  await page.locator('.filter-card').filter({hasText:'总览'}).click()
  await page.locator('.overview-table tbody tr').filter({hasText:'待核条目 32'}).first().waitFor()
  if(onlyFailed){await page.locator('.overview-stat-card').filter({hasText:'不通过项'}).click();await page.getByRole('heading',{name:'全部不通过项'}).waitFor();assert.equal(await page.locator('.overview-section-list').getByText('正常条目',{exact:true}).count(),0)}
  const row=page.locator('.overview-table tbody tr').filter({hasText:'待核条目 32'}).first()
  await row.scrollIntoViewIfNeeded()
  const before=await page.evaluate(()=>window.scrollY);assert.ok(before>500)
  await row.getByRole('button',{name:'查看',exact:true}).click()
  await page.locator('.detail-container').waitFor();assert.match(await page.locator('.detail-container').innerText(),/待核条目 32/)
  await page.getByRole('button',{name:'返回总览原位置'}).click()
  await page.locator('.overview-container').waitFor()
  assert.ok(Math.abs(await page.evaluate(()=>window.scrollY)-before)<8)
  if(onlyFailed) await page.getByRole('heading',{name:'全部不通过项'}).waitFor()
 })
}
