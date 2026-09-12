// Money arrives from the API as integer cents and stays that way; this only formats for display.
export function formatMoney(cents) {
  if (cents === null || cents === undefined) return '—'
  if (!Number.isInteger(cents)) throw new TypeError('formatMoney expects integer cents')
  const negative = cents < 0
  const digits = String(Math.abs(cents)).padStart(3, '0')
  const dollars = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${dollars}.${digits.slice(-2)}`
}
