import { useRef, useState } from 'react'

export default function FileUpload({ accept = '.pdf,.json', onChange, label = '拖拽或点击上传文件', fileName }) {
  const [isDragOver, setIsDragOver] = useState(false)
  const inputRef = useRef(null)

  function handleDragEnter(e) {
    e.preventDefault()
    setIsDragOver(true)
  }

  function handleDragLeave(e) {
    e.preventDefault()
    setIsDragOver(false)
  }

  function handleDrop(e) {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0] ?? null
    if (file) onChange(file)
  }

  function handleClick() {
    inputRef.current?.click()
  }

  return (
    <div
      className={`file-upload ${isDragOver ? 'file-upload-active' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="file-upload-input"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null
          if (file) onChange(file)
        }}
      />
      <span className="file-upload-label">{label}</span>
      {fileName ? <small className="file-upload-name">{fileName}</small> : null}
    </div>
  )
}
