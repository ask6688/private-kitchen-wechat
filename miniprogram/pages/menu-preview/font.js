// Draw the bundled WenKai contours with ordinary Canvas paths; no native font registration.
const FAMILY = 'KitchenMenuWenkaiPaths'
function parseGlyphs(buffer) {
  const view = ArrayBuffer.isView(buffer) ? new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new DataView(buffer)
  if (view.byteLength < 24 || view.getUint32(0, true) !== 0x3150474d) throw new Error('Menu 字形文件不完整')
  const units = view.getUint16(4, true), scale = view.getUint16(6, true)
  const count = view.getUint32(16, true), start = view.getUint32(20, true)
  if (!units || scale !== 2 || start !== 24 + count * 16 || start > view.byteLength) throw new Error('Menu 字形文件不完整')
  const glyphs = new Map()
  for (let i = 0; i < count; i++) {
    const at = 24 + i * 16, offset = start + view.getUint32(at + 8, true), length = view.getUint32(at + 12, true)
    if (offset < start || offset + length > view.byteLength) throw new Error('Menu 字形文件不完整')
    glyphs.set(view.getUint32(at, true), { advance: view.getUint16(at + 4, true), ascent: view.getInt16(at + 6, true), offset, length })
  }
  return { view, units, scale, glyphs }
}
function loadMenuFont() {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(new Error('Menu 字形读取超时，请重试')), 8000)
    function finish(error, font) {
      if (settled) return
      settled = true; clearTimeout(timer)
      error ? reject(error) : resolve(font)
    }
    try {
      wx.getFileSystemManager().readCompressedFile({
        filePath: '/fonts/kitchen-menu-glyphs.br', compressionAlgorithm: 'br',
        success: ({ data }) => {
          if (settled) return
          try { finish(null, parseGlyphs(data)) } catch (error) { finish(error) }
        },
        fail: () => finish(new Error('Menu 字形暂未读到，请重试')),
      })
    } catch (error) { finish(error) }
  })
}
function drawGlyph(ctx, font, glyph, x, y, size) {
  const { view } = font
  let at = glyph.offset, px = 0, py = 0
  const delta = () => { const small = view.getInt8(at++); if (small !== -128) return small * 2; const value = view.getInt16(at, true); at += 2; return value }
  const point = () => { px += delta(); py += delta(); return [px / font.scale, py / font.scale] }
  ctx.save(); ctx.translate(x, y); ctx.scale(size / font.units, -size / font.units); ctx.beginPath()
  while (at < glyph.offset + glyph.length) {
    const op = view.getUint8(at++)
    if (op === 0) ctx.closePath()
    else if (op === 1 || op === 2) {
      const p = point(); op === 1 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])
    } else if (op === 4) {
      const a = point(), b = point(), end = point(); ctx.bezierCurveTo(a[0], a[1], b[0], b[1], end[0], end[1])
    } else {
      const count = op === 3 ? 1 : op - 3
      let control = point()
      for (let i = 1; i < count; i++) {
        const next = point(); ctx.quadraticCurveTo(control[0], control[1], (control[0] + next[0]) / 2, (control[1] + next[1]) / 2); control = next
      }
      const end = point(); ctx.quadraticCurveTo(control[0], control[1], end[0], end[1])
    }
  }
  ctx.fill(); ctx.restore()
}
function createLettering(ctx, font) {
  // The optional font also allows existing synthetic-context layout checks to keep their own metrics.
  if (!font) return ctx
  const size = () => Number((ctx.font.match(/([\d.]+)px/) || [0, 23])[1])
  const isMenuFont = () => ctx.font.includes(FAMILY)
  function runs(text) {
    const result = []
    for (const char of String(text == null ? '' : text)) {
      const glyph = font.glyphs.get(char.codePointAt(0))
      if (glyph) result.push({ glyph })
      else if (result.length && result[result.length - 1].text) result[result.length - 1].text += char
      else result.push({ text: char })
    }
    return result
  }
  function fallback(text, px) {
    ctx.save(); ctx.font = `${px}px sans-serif`
    const metrics = ctx.measureText(text); ctx.restore(); return metrics
  }
  function measure(text, px) {
    let width = 0, ascent = 0
    for (const run of runs(text)) {
      const metrics = run.glyph ? { width: run.glyph.advance * px / font.units, actualBoundingBoxAscent: run.glyph.ascent * px / font.units } : fallback(run.text, px)
      width += metrics.width; ascent = Math.max(ascent, metrics.actualBoundingBoxAscent || 0)
    }
    return { width, actualBoundingBoxAscent: ascent }
  }
  return {
    measureText(text) { return isMenuFont() ? measure(text, size()) : ctx.measureText(text) },
    fillText(text, x, y) {
      if (!isMenuFont()) return ctx.fillText(text, x, y)
      const px = size(), width = measure(text, px).width
      if (ctx.textAlign === 'center') x -= width / 2
      else if (ctx.textAlign === 'right' || ctx.textAlign === 'end') x -= width
      ctx.save(); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
      for (const run of runs(text)) {
        if (run.glyph) {
          drawGlyph(ctx, font, run.glyph, x, y, px); x += run.glyph.advance * px / font.units
        } else {
          // Keep rare characters/emoji and their shaping; never substitute or drop user text.
          ctx.font = `${px}px sans-serif`; ctx.fillText(run.text, x, y); x += ctx.measureText(run.text).width
        }
      }
      ctx.restore()
    },
  }
}
module.exports = { FAMILY, loadMenuFont, parseGlyphs, createLettering }
