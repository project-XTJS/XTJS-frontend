export default function StatItem({ label, value }) {
  return (
    <div className="stat-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
