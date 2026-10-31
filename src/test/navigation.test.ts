import { describe, expect, it } from 'vitest'
import { landingTarget } from '../lib/navigation'

describe('landing target after signing in', () => {
  it('returns the exact route the user asked for', () => {
    expect(landingTarget({ from: '/bills/123' })).toBe('/bills/123')
    expect(landingTarget({ from: '/reports?year=2026' })).toBe('/reports?year=2026')
    expect(landingTarget({ from: '/customers/9' })).toBe('/customers/9')
  })
  it('falls back to the dashboard when there was no deep link', () => {
    expect(landingTarget(undefined)).toBe('/')
    expect(landingTarget(null)).toBe('/')
    expect(landingTarget({})).toBe('/')
    expect(landingTarget({ from: '/' })).toBe('/')
    expect(landingTarget({ from: '' })).toBe('/')
  })
  it('never redirects off this origin', () => {
    expect(landingTarget({ from: '//evil.com/steal' })).toBe('/')
    expect(landingTarget({ from: 'https://evil.com' })).toBe('/')
    expect(landingTarget({ from: '/\\evil.com' })).toBe('/')
    expect(landingTarget({ from: 'bills/123' })).toBe('/')
    expect(landingTarget({ from: 42 })).toBe('/')
  })
  it('never bounces back to the auth screens', () => {
    expect(landingTarget({ from: '/signin' })).toBe('/')
    expect(landingTarget({ from: '/signin/extra' })).toBe('/')
    expect(landingTarget({ from: '/onboarding' })).toBe('/')
    expect(landingTarget({ from: '/onboarding/step/2' })).toBe('/')
    expect(landingTarget({ from: '/signin?from=/bills/1' })).toBe('/')
  })
})
