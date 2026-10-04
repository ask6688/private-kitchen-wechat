const assert = require('node:assert/strict')
const fs = require('node:fs')
const { brotliDecompressSync } = require('node:zlib')
const { FAMILY, loadMenuFont, parseGlyphs, createLettering } = require('../miniprogram/pages/menu-preview/font')
const data = brotliDecompressSync(fs.readFileSync(require.resolve('../miniprogram/fonts/kitchen-menu-glyphs.br')))
const font = parseGlyphs(data)
const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
assert.equal(parseGlyphs(arrayBuffer).glyphs.size, font.glyphs.size)
assert.ok(font.glyphs.size >= 6897, 'the local atlas retains the bundled Chinese and Latin coverage')
assert.equal(font.units, 1000)
assert.throws(() => parseGlyphs(new ArrayBuffer(4)), /字形文件不完整/)
assert.throws(() => parseGlyphs(data.subarray(0, data.length - 1)), /字形文件不完整/)

const unknown = '𠮷👩‍🍳'
assert.ok(Array.from(unknown).every(char => !font.glyphs.has(char.codePointAt(0))))
const paths = [], nativeText = [], measurements = [], states = []
const context = {
  font: `23px ${FAMILY}`, textAlign: 'center', textBaseline: 'alphabetic',
  save() { states.push({ font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline }) },
  restore() { Object.assign(this, states.pop()) },
  measureText(text) {
    measurements.push({ text, font: this.font })
    assert.ok(!this.font.includes(FAMILY), 'known glyphs never ask the platform font loader for metrics')
    return { width: text === unknown ? 37 : Array.from(text).length * 15, actualBoundingBoxAscent: 19 }
  },
  fillText(text, x, y) { nativeText.push({ text, x, y, font: this.font, align: this.textAlign }) },
}
for (const method of ['translate', 'scale', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'fill']) {
  context[method] = (...args) => {
    assert.ok(args.every(Number.isFinite), `${method} receives real finite contour coordinates`)
    paths.push([method, ...args])
  }
}
const lettering = createLettering(context, font)
assert.deepEqual(lettering.measureText('永 A'), { width: 46.92, actualBoundingBoxAscent: 18.4 })
assert.equal(measurements.length, 0, 'Chinese, Latin and spaces use atlas advances')
lettering.fillText('永', 300, 100)
assert.deepEqual(paths.slice(0, 6), [
  ['translate', 288.5, 100], ['scale', .023, -.023], ['beginPath'],
  ['moveTo', 360, 743], ['quadraticCurveTo', 341, 749, 341, 762], ['quadraticCurveTo', 341, 768, 344, 777],
], 'the real 永 contour has the expected baseline, coordinates and quadratic curves')
assert.ok(paths.some(path => path[0] === 'closePath'))
assert.equal(paths.at(-1)[0], 'fill')
assert.equal(nativeText.length, 0, 'covered Chinese is drawn only with ordinary Canvas paths')

paths.length = measurements.length = 0
const mixed = `永${unknown}A`, width = 23 + 37 + 15.87
assert.deepEqual(lettering.measureText(mixed), { width, actualBoundingBoxAscent: 19 })
assert.deepEqual(measurements, [{ text: unknown, font: '23px sans-serif' }], 'adjacent missing characters retain one shaping run, including supplementary Unicode and ZWJ')
lettering.fillText(mixed, 300, 100)
assert.deepEqual(nativeText, [{ text: unknown, x: 300 - width / 2 + 23, y: 100, font: '23px sans-serif', align: 'left' }])
assert.deepEqual(paths.filter(path => path[0] === 'translate'), [
  ['translate', 300 - width / 2, 100], ['translate', 300 - width / 2 + 23 + 37, 100],
], 'fallback and atlas advances place the next outlined glyph at the measured position')
assert.equal(context.font, `23px ${FAMILY}`)
assert.equal(context.textAlign, 'center')
assert.equal(states.length, 0, 'drawing restores Canvas state')
paths.length = nativeText.length = 0
context.textAlign = 'right'; lettering.fillText('永', 300, 100)
assert.deepEqual(paths[0], ['translate', 277, 100])
paths.length = 0
context.font = '15px sans-serif'; lettering.fillText('心得', 300, 120)
assert.equal(lettering.measureText('心得').width, 30)
assert.equal(paths.length, 0, 'ordinary notes keep their system text renderer')
assert.deepEqual(nativeText, [{ text: '心得', x: 300, y: 120, font: '15px sans-serif', align: 'right' }])

let read
global.wx = {
  getFileSystemManager: () => ({ readCompressedFile(options) {
    assert.equal(options.filePath, '/fonts/kitchen-menu-glyphs.br')
    assert.equal(options.compressionAlgorithm, 'br')
    read = options
  } }),
  loadFontFace() { assert.fail('glyph rendering must never register a native font') },
}
async function main() {
  let ready = false
  const pending = loadMenuFont().then(value => { ready = true; return value })
  await Promise.resolve()
  assert.equal(ready, false, 'export cannot proceed while the local atlas is unread')
  read.success({ data: arrayBuffer })
  const loaded = await pending
  assert.equal(loaded.glyphs.size, font.glyphs.size)
  assert.equal(loaded.glyphs.get('永'.codePointAt(0)).length, 303)
  const failed = loadMenuFont(); read.fail()
  await assert.rejects(failed, /字形暂未读到/)
  const corrupt = loadMenuFont(); read.success({ data: new ArrayBuffer(4) })
  await assert.rejects(corrupt, /字形文件不完整/)
  const retry = loadMenuFont(); read.success({ data: arrayBuffer }); await retry
  const nativeTimer = global.setTimeout
  let expire, timedOut
  try {
    global.setTimeout = callback => { expire = callback; return 0 }
    timedOut = loadMenuFont()
  } finally { global.setTimeout = nativeTimer }
  expire(); await assert.rejects(timedOut, /字形读取超时/)
  assert.doesNotThrow(() => read.success({ data: new ArrayBuffer(0) }), 'late reads cannot revive or parse after a timeout')
  console.log('Menu 本地字形、真实路径与度量、缺字连续补字、Unicode、失败重试与超时检查通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
