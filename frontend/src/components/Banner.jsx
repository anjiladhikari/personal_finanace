// Inline status message: error / success / info. Renders nothing without a message.
export default function Banner({ kind = 'info', children }) {
  if (!children) return null
  const styles = {
    error: 'border-rose-200 bg-rose-50 text-rose-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    info: 'border-slate-200 bg-slate-100 text-slate-700',
  }
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${styles[kind]}`}>
      {children}
    </div>
  )
}
