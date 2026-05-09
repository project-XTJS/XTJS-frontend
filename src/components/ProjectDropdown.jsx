import { useEffect, useRef, useState } from 'react'

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

  var selected = projects.find(function (p) { return p.identifier_id === selectedProjectId })

  var filtered = projects.filter(function (p) {
    if (!search.trim()) return true
    var kw = search.trim().toLowerCase()
    return (p.identifier_id || '').toLowerCase().includes(kw)
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
          {selected ? selected.identifier_id : '选择项目'}
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
                return (
                  <button
                    type="button"
                    key={project.identifier_id}
                    className={'dropdown-item' + (selectedProjectId === project.identifier_id ? ' is-active' : '')}
                    onClick={function () { select(project.identifier_id) }}
                  >
                    <span>{project.identifier_id}</span>
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
