import { describe, expect, it } from 'vitest'
import { formatMoney } from '../money.js'

describe('formatMoney', () => {
  it('formats integer cents for display', () => {
    expect(formatMoney(12345)).toBe('$123.45')
    expect(formatMoney(-12345)).toBe('-$123.45')
    expect(formatMoney(5)).toBe('$0.05')
    expect(formatMoney(0)).toBe('$0.00')
    expect(formatMoney(123456789)).toBe('$1,234,567.89')
    expect(formatMoney(null)).toBe('—')
  })

  it('refuses non-integer input instead of guessing', () => {
    expect(() => formatMoney(12.5)).toThrow(TypeError)
    expect(() => formatMoney('12345')).toThrow(TypeError)
  })
})
