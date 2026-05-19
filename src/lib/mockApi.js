// Mock API for offline testing.
// Enable via: set VITE_USE_MOCK_API=true in .env or .env.local

// ─── Mock project listing ──────────────────────────

const MOCK_PROJECTS = {
  items: [
    {
      identifier_id: 'ship-ad-project',
      create_time: '2026-05-08T10:30:00',
      update_time: '2026-05-09T14:00:00',
    },
    {
      identifier_id: 'server-procurement',
      create_time: '2026-05-07T09:00:00',
      update_time: '2026-05-08T18:30:00',
    },
  ],
}

export async function mockListProjects(_opts) {
  // Simulate slight network delay
  await new Promise(function (r) { setTimeout(r, 150) })
  return MOCK_PROJECTS
}

// ─── Mock visualization data ────────────────────────

const MOCK_VISUALIZATION = {
  results: {
    duplicate_check: {
      groups: {
        business_bid: {
          items: [
            {
              suspicious: true,
              risk_level: 'high',
              match_score: 0.82,
              left_file_name: '亚元商务标.pdf',
              right_file_name: '阳生文化商务标.pdf',
              left_document_identifier: 'doc-left-001',
              right_document_identifier: 'doc-right-001',
              metrics: {
                exact_block_count: 8,
                exact_block_overlap_ratio: 0.62,
                similar_block_count: 5,
              },
              duplicate_blocks: [
                {
                  text: '船体外灯箱广告 | 与招标文件条款相同 | 无偏离',
                  type: 'sentence',
                  left_page: 8,
                  right_page: 8,
                },
                {
                  text: '游船舱内广告 | 与招标文件条款相同 | 无偏离',
                  type: 'sentence',
                  left_page: 8,
                  right_page: 8,
                },
                {
                  text: '独立活动场地 | 与招标文件条款相同 | 无偏离',
                  type: 'sentence',
                  left_page: 9,
                  right_page: 9,
                },
              ],
              similar_blocks: [
                {
                  left_page: 5,
                  right_page: 5,
                  left_text: '船体外灯箱广告 一年 4990000 1 4990000',
                  right_text: '船体外灯箱广告 一年 5000000 1 5000000',
                  similarity: 1,
                },
              ],
            },
            {
              suspicious: true,
              risk_level: 'medium',
              match_score: 0.45,
              left_file_name: '翡翠商务标.pdf',
              right_file_name: '善元商务标.pdf',
              left_document_identifier: 'doc-left-002',
              right_document_identifier: 'doc-right-002',
              metrics: {
                exact_block_count: 2,
                exact_block_overlap_ratio: 0.18,
                similar_block_count: 3,
              },
              duplicate_blocks: [
                {
                  text: '投标报价总价 // 人民币伍佰万元整',
                  type: 'sentence',
                  left_page: 3,
                  right_page: 4,
                },
              ],
              similar_blocks: [],
            },
          ],
        },
      },
    },
    typo_check: {
      groups: {
        technical_bid: {
          typo_check: {
            documents: [
              {
                file_name: '技术响应文件-通用服务器采购项目（信投智科）.pdf',
                identifier_id: 'doc-typo-001',
                items: [
                  {
                    page: 56,
                    file_name: '技术响应文件-通用服务器采购项目（信投智科）.pdf',
                    issue_key: '帐号',
                    issue_type: 'known_typo',
                    matched_text: '帐号',
                    suggestion: '账号',
                    document_identifier_id: 'doc-typo-001',
                  },
                  {
                    page: 82,
                    file_name: '技术响应文件-通用服务器采购项目（信投智科）.pdf',
                    issue_key: '其它',
                    issue_type: 'known_typo',
                    matched_text: '其它',
                    suggestion: '其他',
                    document_identifier_id: 'doc-typo-001',
                  },
                ],
              },
              {
                file_name: '技术响应文件-通用服务器采购项目（华存）.pdf',
                identifier_id: 'doc-typo-002',
                items: [
                  {
                    page: 12,
                    file_name: '技术响应文件-通用服务器采购项目（华存）.pdf',
                    issue_key: '连接',
                    issue_type: 'known_typo',
                    matched_text: '联接',
                    suggestion: '连接',
                    document_identifier_id: 'doc-typo-002',
                  },
                ],
              },
            ],
          },
        },
      },
    },
    personnel_reuse_check: {
      groups: {
        business_bid: {
          personnel_reuse_check: {
            items: [
              {
                name: '张三',
                document_count: 4,
                documents: [
                  { identifier_id: 'doc-left-001', file_name: '亚元商务标.pdf' },
                  { identifier_id: 'doc-right-001', file_name: '阳生文化商务标.pdf' },
                  { identifier_id: 'doc-left-002', file_name: '翡翠商务标.pdf' },
                  { identifier_id: 'doc-right-002', file_name: '善元商务标.pdf' },
                ],
              },
              {
                name: '李四',
                document_count: 2,
                documents: [
                  { identifier_id: 'doc-left-001', file_name: '亚元商务标.pdf' },
                  { identifier_id: 'doc-right-001', file_name: '阳生文化商务标.pdf' },
                ],
              },
            ],
          },
        },
      },
    },
    business_bid_format_review: null,
    bid_document_review: null,
  },
}

export async function mockGetProjectVisualizationData(_projectId) {
  await new Promise(function (r) { setTimeout(r, 200) })
  return MOCK_VISUALIZATION
}

// ─── Mock document preview ──────────────────────────

// Inline SVG placeholder that looks like a document page
function makePlaceholderSvg(label, page) {
  var svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="520" viewBox="0 0 400 520">' +
    '<rect width="400" height="520" fill="#fafbfc" rx="4"/>' +
    '<rect x="28" y="28" width="344" height="464" fill="#fff" rx="2" stroke="#e2e8f0" stroke-width="1"/>' +
    '<rect x="48" y="72" width="304" height="12" fill="#e2e8f0" rx="3"/>' +
    '<rect x="48" y="100" width="260" height="12" fill="#e2e8f0" rx="3"/>' +
    '<rect x="48" y="132" width="304" height="12" fill="#e2e8f0" rx="3"/>' +
    '<rect x="48" y="164" width="200" height="12" fill="#e2e8f0" rx="3"/>' +
    '<rect x="48" y="204" width="304" height="12" fill="#f1f5f9" rx="3"/>' +
    '<rect x="48" y="232" width="280" height="12" fill="#f1f5f9" rx="3"/>' +
    '<rect x="48" y="260" width="304" height="12" fill="#f1f5f9" rx="3"/>' +
    '<rect x="48" y="292" width="220" height="12" fill="#f1f5f9" rx="3"/>' +
    '<rect x="48" y="340" width="304" height="12" fill="#e2e8f0" rx="3"/>' +
    '<rect x="48" y="368" width="190" height="12" fill="#e2e8f0" rx="3"/>' +
    '<text x="200" y="492" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#64748b">' +
    escapeXml(label) + ' — 第 ' + page + ' 页</text>' +
    '</svg>'
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// For test: pre-generate some placeholder pages
var PLACEHOLDER_CACHE = {}
function getPlaceholder(label, page) {
  var key = label + '|' + page
  if (!PLACEHOLDER_CACHE[key]) {
    PLACEHOLDER_CACHE[key] = {
      page: page,
      page_count: 100,
      image_data_url: makePlaceholderSvg(label, page),
    }
  }
  return PLACEHOLDER_CACHE[key]
}

export async function mockGetDocumentPreview(documentId, page) {
  await new Promise(function (r) { setTimeout(r, 100) })
  // Use the doc ID as label
  var label = documentId || '文档'
  return getPlaceholder(label, page)
}

// ─── Mock export report ────────────────────────────

export async function mockExportReport(_projectId, _opts) {
  await new Promise(function (r) { setTimeout(r, 500) })
  // Return a tiny dummy PDF blob
  return new Blob(['%PDF-1.4 mock'], { type: 'application/pdf' })
}
