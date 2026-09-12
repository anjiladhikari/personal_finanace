// Labelled form control wrapper so every input has a real <label>.
export default function Field({ id, label, children, className = '' }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-slate-600">
        {label}
      </label>
      {children}
    </div>
  )
}
