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
const fulfill = (route, data, status = 200) => route.fulfill({ status, json: { code: status, message: status === 200 ? 'success' : '测试加载失败', data } })

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
})
