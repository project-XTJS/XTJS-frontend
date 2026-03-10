import { useRef, useState } from 'react'
import './App.css'

const projects = [
  {
    id: 'XT-2026-041',
    name: '城市更新配套设备采购项目',
    owner: '采购审查中心',
    stage: '分析中',
    progress: 68,
    updatedAt: '2026-03-10 16:20',
    tenderFile: '招标文件_v3.pdf',
    bidCount: 4,
    summary: '资格项已完成，正在比对商务与技术响应。',
    checkpoints: [
      { name: '项目创建', status: 'done' },
      { name: '招标解析', status: 'done' },
      { name: '投标比对', status: 'active' },
      { name: '结果生成', status: 'pending' },
    ],
    results: [
      { title: '资格性审查', status: '通过', detail: '基础资格文件齐全。' },
      { title: '响应性审查', status: '关注', detail: '检测到 2 处付款节点偏离。' },
      { title: '技术偏离', status: '分析中', detail: '参数表匹配已完成 87%。' },
    ],
    evidence: [
      '华建联合体，第 132 页：付款节点表述不一致。',
      '远拓机电，第 88 页：交货周期描述偏离。',
      '金石智能，第 24 页：检测报告有效期临近。',
    ],
  },
  {
    id: 'XT-2026-038',
    name: '智慧园区安防集成项目',
    owner: '数智建设部',
    stage: '待分析',
    progress: 24,
    updatedAt: '2026-03-10 14:05',
    tenderFile: '安防集成招标文件.pdf',
    bidCount: 3,
    summary: '文件已上传，等待进入首轮比对。',
    checkpoints: [
      { name: '项目创建', status: 'done' },
      { name: '招标解析', status: 'active' },
      { name: '投标比对', status: 'pending' },
      { name: '结果生成', status: 'pending' },
    ],
    results: [{ title: '当前状态', status: '排队中', detail: '正在提取招标关键条款。' }],
    evidence: ['已识别招标目录。', '3 份投标文件已进入待解析队列。'],
  },
  {
    id: 'XT-2026-031',
    name: '沿江排水改造工程',
    owner: '工程审查组',
    stage: '已完成',
    progress: 100,
    updatedAt: '2026-03-08 18:40',
    tenderFile: '排水改造招标文件.pdf',
    bidCount: 5,
    summary: '结果已生成，可直接查看。',
    checkpoints: [
      { name: '项目创建', status: 'done' },
      { name: '招标解析', status: 'done' },
      { name: '投标比对', status: 'done' },
      { name: '结果生成', status: 'done' },
    ],
    results: [
      { title: '综合结论', status: '已生成', detail: '发现 3 项资格风险，2 项商务偏离。' },
      { title: '证据链', status: '完整', detail: '已绑定页码定位与原文摘录。' },
    ],
    evidence: [
      '华江建设，第 57 页：安全生产许可证编号缺失。',
      '泽远工程，第 119 页：质保期限低于招标要求。',
    ],
  },
]

const uploadQueue = [
  { name: '招标文件_v3.pdf', type: '招标文件', status: '已上传', size: '18.4 MB' },
  { name: '华建联合体_投标文件.pdf', type: '投标文件', status: '解析中', size: '24.1 MB' },
  { name: '远拓机电_投标文件.pdf', type: '投标文件', status: '待分析', size: '19.6 MB' },
  { name: '金石智能_投标文件.pdf', type: '投标文件', status: '待分析', size: '22.3 MB' },
]

function App() {
  const [activeProjectId, setActiveProjectId] = useState(projects[0].id)
  const activeProject = projects.find((item) => item.id === activeProjectId) ?? projects[0]
  const createSectionRef = useRef(null)
  const projectsSectionRef = useRef(null)

  const scrollToSection = (ref) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>信投建设智能审标平台</h1>
          <p className="intro">项目创建、文件上传、分析进度、结果查看</p>
        </div>

        <div className="top-actions">
          <button type="button" className="primary-button" onClick={() => scrollToSection(createSectionRef)}>
            新建项目
          </button>
          <button type="button" className="ghost-button" onClick={() => scrollToSection(projectsSectionRef)}>
            项目进度
          </button>
        </div>
      </header>

      <main className="layout-grid">
        <section className="hero-panel panel">
          <div className="hero-copy">
            <p className="section-tag">入口</p>
            <h2>围绕分析比对流程设计</h2>
            <p>上传 1 份招标文件和多份投标文件，持续查看项目进度，完成后进入结果。</p>
          </div>

          <div className="hero-flow">
            <div className="flow-node active">
              <span />
              <strong>新建项目</strong>
            </div>
            <div className="flow-node active">
              <span />
              <strong>上传文件</strong>
            </div>
            <div className="flow-node current">
              <span />
              <strong>分析比对</strong>
            </div>
            <div className="flow-node">
              <span />
              <strong>查看结果</strong>
            </div>
          </div>
        </section>

        <section className="create-grid" id="create" ref={createSectionRef}>
          <article className="panel create-panel">
            <div className="panel-head">
              <div>
                <p className="section-tag">新建项目</p>
                <h3>基础信息</h3>
              </div>
            </div>

            <div className="field-grid">
              <label className="field">
                <span>项目名称</span>
                <input value="城市更新配套设备采购项目" readOnly />
              </label>
              <label className="field">
                <span>项目编号</span>
                <input value="XT-2026-041" readOnly />
              </label>
              <label className="field">
                <span>审查模板</span>
                <input value="设备采购 / 综合评分法" readOnly />
              </label>
              <label className="field">
                <span>负责部门</span>
                <input value="采购审查中心" readOnly />
              </label>
            </div>

            <button type="button" className="wide-button">
              创建项目
            </button>
          </article>

          <article className="panel upload-panel">
            <div className="panel-head">
              <div>
                <p className="section-tag">上传文件</p>
                <h3>招标文件与投标文件</h3>
              </div>
            </div>

            <div className="upload-actions">
              <button type="button" className="upload-card upload-card-primary">
                <strong>上传招标文件</strong>
                <p>每个项目 1 份</p>
              </button>
              <button type="button" className="upload-card">
                <strong>上传投标文件</strong>
                <p>支持多份</p>
              </button>
            </div>

            <div className="queue-list">
              {uploadQueue.map((file) => (
                <article className="queue-item" key={file.name}>
                  <div>
                    <span className="queue-type">{file.type}</span>
                    <strong>{file.name}</strong>
                  </div>
                  <div className="queue-meta">
                    <span>{file.size}</span>
                    <span>{file.status}</span>
                  </div>
                </article>
              ))}
            </div>
          </article>
        </section>

        <section className="workspace-grid" id="projects" ref={projectsSectionRef}>
          <aside className="panel project-list-panel">
            <div className="panel-head">
              <div>
                <p className="section-tag">项目列表</p>
                <h3>分析进度</h3>
              </div>
            </div>

            <div className="project-list">
              {projects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  className={`project-item ${project.id === activeProject.id ? 'is-active' : ''}`}
                  onClick={() => setActiveProjectId(project.id)}
                >
                  <div className="project-item-top">
                    <div>
                      <strong>{project.name}</strong>
                      <span>{project.id}</span>
                    </div>
                    <em>{project.stage}</em>
                  </div>

                  <p>{project.summary}</p>

                  <div className="progress-row">
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${project.progress}%` }} />
                    </div>
                    <span>{project.progress}%</span>
                  </div>

                  <div className="project-item-bottom">
                    <span>{project.bidCount} 份投标文件</span>
                    <span>{project.updatedAt}</span>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <section className="panel detail-panel">
            <div className="panel-head">
              <div>
                <p className="section-tag">项目结果</p>
                <h3>{activeProject.name}</h3>
              </div>
              <button type="button" className="ghost-button detail-button">
                查看详情
              </button>
            </div>

            <div className="detail-meta">
              <div>
                <span>项目编号</span>
                <strong>{activeProject.id}</strong>
              </div>
              <div>
                <span>招标文件</span>
                <strong>{activeProject.tenderFile}</strong>
              </div>
              <div>
                <span>负责部门</span>
                <strong>{activeProject.owner}</strong>
              </div>
              <div>
                <span>最后更新</span>
                <strong>{activeProject.updatedAt}</strong>
              </div>
            </div>

            <div className="checkpoint-row">
              {activeProject.checkpoints.map((item) => (
                <div key={item.name} className={`checkpoint checkpoint-${item.status}`}>
                  <span />
                  <strong>{item.name}</strong>
                </div>
              ))}
            </div>

            <div className="detail-columns">
              <div className="result-stack">
                {activeProject.results.map((item) => (
                  <article className="result-block" key={item.title}>
                    <div className="result-head">
                      <strong>{item.title}</strong>
                      <span>{item.status}</span>
                    </div>
                    <p>{item.detail}</p>
                  </article>
                ))}
              </div>

              <div className="evidence-panel">
                <div className="evidence-head">
                  <p className="section-tag">证据摘录</p>
                  <h4>定位信息</h4>
                </div>
                <div className="evidence-list">
                  {activeProject.evidence.map((item) => (
                    <article className="evidence-item" key={item}>
                      <span />
                      <p>{item}</p>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </section>
      </main>
    </div>
  )
}

export default App
