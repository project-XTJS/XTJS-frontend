export default function StatusPill({ label, className }) {
  return <span className={`status-pill ${className ?? ''}`}>{label}</span>
}
