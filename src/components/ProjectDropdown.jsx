import { useEffect, useRef, useState } from 'react'

function getProjectIdentifier(project) {
  return project?.identifier_id || project?.id || project?.project_name || project?.projectName || ''
}

function getProjectLabel(project) {
  var projectName = project?.project_name || project?.projectName
  var identifierId = project?.identifier_id || project?.id
  if (projectName && identifierId && projectName !== identifierId) {
    return projectName + '（' + identifierId.slice(0, 8) + '）'
  }
  return projectName || identifierId || ''
}

export default function ProjectDropdown({ projects, selectedProjectId, onChange }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)

  useEffect(function () {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return function () { document.removeEventListener('mousedown', handleClickOutside) }
  }, [])

  var selected = projects.find(function (p) { return getProjectIdentifier(p) === selectedProjectId })

  var filtered = projects.filter(function (p) {
    if (!search.trim()) return true
    var kw = search.trim().toLowerCase()
    return [getProjectIdentifier(p), getProjectLabel(p)]
      .some(function (value) { return value.toLowerCase().includes(kw) })
  })

  function select(projectId) {
    onChange(projectId)
    setOpen(false)
    setSearch('')
  }

  return (
    <div className="project-dropdown" ref={ref}>
      <button
        type="button"
        className="project-dropdown-trigger"
        onClick={function () { setOpen(function (o) { return !o }) }}
      >
        <span className={selected ? '' : 'dropdown-placeholder'}>
          {selected ? getProjectLabel(selected) : '选择项目'}
        </span>
        <span className="dropdown-arrow">{open ? '▲' : '▼'}</span>
      </button>

      {open ? (
        <div className="project-dropdown-menu">
          <div className="dropdown-search">
            <input
              type="text"
              placeholder="搜索项目..."
              value={search}
              onChange={function (e) { setSearch(e.target.value) }}
              autoFocus
            />
          </div>
          <div className="dropdown-list">
            {filtered.length > 0 ? (
              filtered.map(function (project) {
                var projectValue = getProjectIdentifier(project)
                return (
                  <button
                    type="button"
                    key={projectValue}
                    className={'dropdown-item' + (selectedProjectId === projectValue ? ' is-active' : '')}
                    onClick={function () { select(projectValue) }}
                  >
                    <span>{getProjectLabel(project)}</span>
                  </button>
                )
              })
            ) : (
              <div className="dropdown-empty">无匹配项目</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
