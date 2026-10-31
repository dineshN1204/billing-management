/**
 * Generates the PWA / app icons.
 *
 * Deliberately dependency-free: it writes PNGs with zlib and the four chunks a
 * PNG actually needs, so the icons can be regenerated on any machine with no
 * install step and no image toolchain. Run it after changing the brand colours:
 *
 *     node scripts/generate-icons.mjs
 *
 * The mark is the same on every size: a dark rounded tile carrying three mint
 * bars of decreasing width - a stack of records - which is the app's subject
 * matter. It is drawn rather than typed so it stays legible down to 32px.
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')

/** Brand colours, matching src/style.css. */
const INK = [0x18, 0x2b, 0x33]      // --sidebar background
const MINT = [0xae, 0xeb, 0xd4]     // --brand-icon background
const WHITE = [0xff, 0xff, 0xff]
void WHITE

/** Rounded-rectangle coverage test, sampled with 3x3 supersampling for smooth edges. */
function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width
  const bottom = top + height
  if (x < left || x > right || y < top || y > bottom) return false
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function blend(target, offset, colour, alpha) {
  for (let channel = 0; channel < 3; channel += 1) {
    target[offset + channel] = Math.round(target[offset + channel] * (1 - alpha) + colour[channel] * alpha)
  }
  target[offset + 3] = Math.round(target[offset + 3] * (1 - alpha) + 255 * alpha)
}

/**
 * Paints the icon into an RGBA buffer.
 *
 * `bleed` is the extra fraction of the canvas kept clear around the mark.
 * A maskable icon is cropped to a circle by the launcher, so its art must
 * survive losing the outer ~10% on every side; the safe-zone inset is what
 * prevents the bars being sliced in half on a Pixel or Galaxy launcher.
 */
function drawIcon(size, { bleed = 0, background = INK, foreground = MINT } = {}) {
  const pixels = Buffer.alloc(size * size * 4, 0)
  const unit = size / 100
  const inset = bleed * unit
  const art = size - inset * 2
  const left = inset
  const top = inset

  const tileRadius = art * (bleed > 0 ? 0.5 : 0.22)

  // Bars: a stack of records, each shorter than the one above.
  const bars = [
    { width: 0.56, thickness: 0.115 },
    { width: 0.44, thickness: 0.115 },
    { width: 0.30, thickness: 0.115 },
  ]
  const barGap = 0.06
  const barLeft = left + art * 0.22
  const barRadius = (art * bars[0].thickness) / 2
  const stackHeight = bars.length * bars[0].thickness + (bars.length - 1) * barGap
  let cursor = top + (art - stackHeight * art) / 2

  const rects = bars.map(bar => {
    const rect = { left: barLeft, top: cursor, width: bar.width * art, height: bar.thickness * art, radius: barRadius }
    cursor += rect.height + barGap * art
    return rect
  })

  const tile = { left, top, width: art, height: art, radius: tileRadius }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Separate coverage accumulators. Collapsing "inside the tile" and
      // "inside a bar" into one counter made the foreground overwrite the
      // background everywhere, which rendered as a flat mint square.
      let tileHits = 0
      const barHits = rects.map(() => 0)
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          const px = x + (sx + 0.5) / 3
          const py = y + (sy + 0.5) / 3
          if (!insideRoundedRect(px, py, tile.left, tile.top, tile.width, tile.height, tile.radius)) continue
          tileHits += 1
          for (let index = 0; index < rects.length; index += 1) {
            const rect = rects[index]
            if (insideRoundedRect(px, py, rect.left, rect.top, rect.width, rect.height, rect.radius)) {
              barHits[index] += 1
            }
          }
        }
      }
      if (tileHits === 0) continue
      const offset = (y * size + x) * 4
      // Painter's algorithm: tile first, then each bar over it.
      blend(pixels, offset, background, tileHits / 9)
      for (let index = 0; index < rects.length; index += 1) {
        if (barHits[index] === 0) continue
        blend(pixels, offset, foreground, barHits[index] / 9)
      }
    }
  }
  return pixels
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Encodes an RGBA buffer as a PNG. */
function encodePng(pixels, size) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8    // bit depth
  header[9] = 6    // colour type: truecolour with alpha
  header[10] = 0   // deflate
  header[11] = 0   // adaptive filtering
  header[12] = 0   // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none".
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(outDir, { recursive: true })

const targets = [
  { file: 'icon-192.png', size: 192, options: {} },
  { file: 'icon-512.png', size: 512, options: {} },
  // Maskable: art inset inside the safe zone so a circular mask cannot clip it.
  { file: 'icon-maskable-192.png', size: 192, options: { bleed: 0.11 } },
  { file: 'icon-maskable-512.png', size: 512, options: { bleed: 0.11 } },
  { file: 'apple-touch-icon.png', size: 180, options: {} },
  { file: 'favicon-32.png', size: 32, options: {} },
]

for (const target of targets) {
  const png = encodePng(drawIcon(target.size, target.options), target.size)
  writeFileSync(join(outDir, target.file), png)
  console.log(`wrote public/icons/${target.file} (${target.size}x${target.size}, ${png.length} bytes)`)
}