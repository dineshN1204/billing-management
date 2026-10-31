import { describe, expect, it } from 'vitest'
import { captureFileName, CAPTURE_MAX_EDGE, MAX_DOCUMENT_BYTES, planCaptureAttempts } from '../lib/image'

describe('capture encoding plan', () => {
  it('leaves an image that already fits the limits untouched', () => {
    expect(planCaptureAttempts(1600, 2 * 1024 * 1024)).toEqual([])
  })
  it('re-encodes when the image is oversized or too large to store', () => {
    expect(planCaptureAttempts(1600, MAX_DOCUMENT_BYTES + 1).length).toBeGreaterThan(0)
    expect(planCaptureAttempts(6000, 1024).length).toBeGreaterThan(0)
  })
  it('reduces resolution only after quality has been lowered', () => {
    const attempts = planCaptureAttempts(4000, MAX_DOCUMENT_BYTES + 1)
    const first = attempts[0]!
    const second = attempts[1]!
    expect(first).toEqual({ maxEdge: CAPTURE_MAX_EDGE, quality: 0.85 })
    expect(second).toEqual({ maxEdge: CAPTURE_MAX_EDGE, quality: 0.7 })
    expect(attempts.at(-1)!.maxEdge).toBeLessThan(first.maxEdge)
  })
  it('never exceeds the source resolution and keeps a usable floor', () => {
    const attempts = planCaptureAttempts(900, MAX_DOCUMENT_BYTES + 1)
    expect(attempts.every(attempt => attempt.maxEdge <= 900)).toBe(true)
    expect(planCaptureAttempts(0, MAX_DOCUMENT_BYTES + 1).every(attempt => attempt.maxEdge >= 320)).toBe(true)
  })
})

describe('capture file naming', () => {
  it('always ends in .jpg so the extension matches the re-encoded content', () => {
    expect(captureFileName('IMG_1234.HEIC')).toBe('IMG_1234.jpg')
    expect(captureFileName('photo')).toBe('photo.jpg')
    expect(captureFileName('')).toBe('capture.jpg')
  })
  it('strips characters the object path and file name columns reject', () => {
    expect(captureFileName('bill #12 (a)/final.png')).toBe('bill--12--a--final.jpg')
    expect(captureFileName('../escape.jpg')).toBe('escape.jpg')
  })
  it('truncates an overlong name', () => {
    expect(captureFileName(`${'a'.repeat(400)}.png`).length).toBeLessThanOrEqual(124)
  })
})
