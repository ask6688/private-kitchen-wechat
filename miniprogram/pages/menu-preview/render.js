// One measured layout for the full Menu keeps photos and short memories on the same paper.
const WIDTH = 600
const INK = '#345443'
const PAPER = '#F8F1E2'
const { FAMILY, createLettering } = require('./font')
const serif = FAMILY
const handwriting = FAMILY
function wrap(ctx, text, width) {
  const lines = []
  let line = ''
  for (const char of String(text || '')) {
    if (char === '\n') { lines.push(line); line = ''; continue }
    if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = char }
    else line += char
  }
  if (line || !lines.length) lines.push(line)
  return lines
}
function groupsFor(items, categories) {
  const order = categories.filter(c => !c.deletedAt).map(c => c.name)
  const groups = []
  for (const item of items) {
    const name = item.category || '未分类'
    let group = groups.find(g => g.name === name)
    if (!group) { group = { name, items: [] }; groups.push(group) }
    group.items.push(item)
  }
  const rank = name => name === '未分类' ? Infinity : order.includes(name) ? order.indexOf(name) : order.length
  return groups.sort((a, b) => rank(a.name) - rank(b.name))
}
function layout(ctx, menu, font) {
  const lettering = createLettering(ctx, font)
  ctx.font = `23px ${handwriting}`
  const titleLines = wrap(lettering, menu.title, 390)
  let y = 204 + (titleLines.length - 1) * 27, index = 0
  const blocks = [], hits = [], photos = []
  let previousGroupBottom = 0
  for (const group of menu.groups) {
    ctx.font = `18px ${serif}`
    const categoryLines = wrap(lettering, group.name, 480)
    const categoryAscent = Math.max(18, ...categoryLines.map(text => lettering.measureText(text).actualBoundingBoxAscent || 18))
    // Category y is a baseline: keep its glyphs 12px below the preceding row and photo shadow.
    y = Math.max(y, previousGroupBottom + 12 + categoryAscent)
    for (const text of categoryLines) { blocks.push({ kind: 'category', text, x: WIDTH / 2, y, align: 'center' }); y += 24 }
    for (const item of group.items) {
      const photo = item.displayPhotos && item.displayPhotos[0]
      const hasPhoto = !!(photo && photo.url), variant = index++ % 4, right = variant % 2 === 1, size = [114, 98, 108, 102][variant]
      const reflection = (item.reflection || '').replace(/\s+/g, ' ').trim()
      ctx.font = `23px ${handwriting}`
      const nameWidth = lettering.measureText(item.name || '').width
      ctx.font = '15px sans-serif'
      // Short names stay near the centre; longer notes open just the space they need.
      const textWidth = hasPhoto ? Math.min(292, Math.max(106, nameWidth, lettering.measureText(reflection).width)) : 492
      const textX = WIDTH / 2 + (hasPhoto ? (right ? -1 : 1) * (textWidth - 120) / 4 : 0)
      ctx.font = `23px ${handwriting}`
      const names = wrap(lettering, item.name, textWidth)
      ctx.font = '15px sans-serif'
      const allNotes = reflection ? wrap(lettering, reflection, textWidth) : []
      const notes = allNotes.slice(0, 2)
      if (allNotes.length > 2) {
        let last = notes[1]
        while (last && lettering.measureText(last + '…').width > textWidth) last = last.slice(0, -1)
        notes[1] = last + '…'
      }
      const contentHeight = names.length * 27 + (notes.length ? 6 + notes.length * 20 : 0)
      const height = Math.max(hasPhoto ? size + 2 : 34, contentHeight + 8)
      // A little vertical drift breaks the ruler-straight rows without crowding longer notes.
      const drift = hasPhoto && height - contentHeight > 32 ? [-9, 10, 5, -7][variant] : 0
      let lineY = y + (height - contentHeight) / 2 + 21 + drift
      for (const text of names) { blocks.push({ kind: 'dish', text, x: textX, y: lineY, align: 'center' }); lineY += 27 }
      if (notes.length) lineY += 4
      for (const text of notes) { blocks.push({ kind: 'note', text, x: textX, y: lineY - 4, align: 'center' }); lineY += 20 }
      previousGroupBottom = y + height
      if (hasPhoto) {
        const photoY = y + (height - size) / 2
        photos.push({ url: photo.url, x: right ? textX + textWidth / 2 + 16 : textX - textWidth / 2 - 16 - size,
          y: photoY, size })
        previousGroupBottom = Math.max(previousGroupBottom, photoY + size + 6)
      }
      hits.push({ id: item.id, name: item.name, recordId: item.recordId || '', top: y, height })
      y += height + 2
    }
  }
  if (!menu.groups.length) { blocks.push({ kind: 'empty', text: '这顿饭还没有菜品', x: WIDTH / 2, y: y + 30, align: 'center' }); y += 70 }
  return { width: WIDTH, height: Math.max(480, y + 92), titleLines, blocks, hits, photos }
}
function random(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 } }
function ellipse(ctx, x, y, rx, ry, rotation, color, alpha = 1) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rotation); ctx.scale(rx, ry)
  ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); ctx.restore()
}
// Original layered pigment shapes, drawn locally; no template image or remote asset.
function decoration(ctx, height) {
  const rand = random(73)
  ctx.save()
  ctx.beginPath(); ctx.rect(0, 0, WIDTH, height); ctx.clip()
  // Scallions: pale stems and a few tapered, translucent green washes.
  for (let n = 0; n < 6; n++) {
    ctx.save(); ctx.translate(rand() * 3, rand() * 3); ctx.globalAlpha = .12
    ctx.fillStyle = '#859B71'
    for (const [tipX, tipY, bend] of [[23, 4, 12], [64, 7, 31], [98, 25, 53]]) {
      ctx.beginPath(); ctx.moveTo(42, 92)
      ctx.quadraticCurveTo(bend, 41, tipX, tipY)
      ctx.quadraticCurveTo(bend + 13, 46, 49, 94); ctx.fill()
    }
    ctx.fillStyle = '#D7D5B8'; ctx.beginPath(); ctx.moveTo(42, 80)
    ctx.quadraticCurveTo(48, 109, 40, 124); ctx.quadraticCurveTo(57, 120, 51, 82); ctx.fill()
    ctx.restore()
  }
  // Two small mushrooms; filled pigment shapes, not outline icons.
  for (const [x, y, scale, angle] of [[29, 139, 1, -.25], [83, 111, .7, .35]]) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.scale(scale, scale)
    for (let n = 0; n < 7; n++) {
      const dx = (rand() - .5) * 3, dy = (rand() - .5) * 3
      ctx.save(); ctx.translate(dx, dy); ctx.globalAlpha = .1
      ctx.fillStyle = '#C8B8A0'; ctx.beginPath(); ctx.moveTo(-7, 0)
      ctx.quadraticCurveTo(-6, 19, -10, 29); ctx.quadraticCurveTo(1, 35, 11, 27)
      ctx.quadraticCurveTo(7, 14, 7, 0); ctx.fill()
      ctx.fillStyle = '#A99179'; ctx.beginPath(); ctx.moveTo(-29, 2)
      ctx.bezierCurveTo(-27, -34, 22, -39, 30, -1)
      ctx.quadraticCurveTo(1, 12, -29, 2); ctx.fill(); ctx.restore()
    }
    ellipse(ctx, 0, 3, 25, 4, 0, '#E4D6BF', .65)
    ctx.restore()
  }
  // A quiet ceramic rice bowl and two wooden chopsticks in the opposite corner.
  ctx.save(); ctx.translate(548, height - 45); ctx.rotate(-.12)
  for (let n = 0; n < 7; n++) {
    ctx.save(); ctx.translate((rand() - .5) * 3, (rand() - .5) * 3); ctx.globalAlpha = .11
    ctx.fillStyle = '#82968A'; ctx.beginPath(); ctx.moveTo(-43, -13)
    ctx.bezierCurveTo(-34, 25, -19, 31, 0, 30)
    ctx.bezierCurveTo(22, 29, 34, 17, 43, -13); ctx.closePath(); ctx.fill()
    ctx.fillStyle = '#A1AA97'; ctx.fillRect(-16, 27, 33, 5); ctx.restore()
  }
  ellipse(ctx, 0, -13, 43, 12, 0, '#ABB6A0', .65)
  ellipse(ctx, 0, -14, 35, 8, 0, '#EDE4CD', .9)
  for (let n = 0; n < 38; n++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand())
    ellipse(ctx, Math.cos(a) * r * 30, -15 + Math.sin(a) * r * 5, 2.5, 1, -.3, '#FFF9E7', .55)
  }
  ctx.restore()
  for (const [x, y] of [[543, height - 72], [546, height - 63]]) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(1.22)
    for (let n = 0; n < 5; n++) {
      ctx.globalAlpha = .13; ctx.fillStyle = '#AC9271'; ctx.beginPath()
      ctx.moveTo(-2 + rand(), -53); ctx.lineTo(3 + rand(), -53)
      ctx.lineTo(1, 47); ctx.lineTo(-1, 47); ctx.closePath(); ctx.fill()
    }
    ctx.restore()
  }
  // A small radish and a wooden spoon sit in the quiet corners, clear of the menu text.
  ctx.save(); ctx.translate(553, 93); ctx.rotate(.35)
  for (let n = 0; n < 5; n++) {
    const d = (rand() - .5) * 2
    ellipse(ctx, d, 5 + d, 14, 19, 0, '#B98676', .07)
    ellipse(ctx, -8 + d, -19, 5, 15, -.6, '#82956C', .09)
    ellipse(ctx, 5 + d, -23, 5, 17, .25, '#82956C', .09)
  }
  ctx.strokeStyle = 'rgba(160,130,106,.25)'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, 23); ctx.quadraticCurveTo(-2, 30, 5, 33); ctx.stroke()
  ctx.restore()
  ctx.save(); ctx.translate(51, height - 46); ctx.rotate(-.6)
  for (let n = 0; n < 5; n++) {
    const d = (rand() - .5) * 2
    ellipse(ctx, d, -15 + d, 10, 16, 0, '#B29A77', .065)
    ellipse(ctx, d, 16 + d, 3, 26, 0, '#B29A77', .065)
  }
  ellipse(ctx, 24, -1, 4, 12, .8, '#8D9E76', .3)
  ellipse(ctx, 28, 10, 4, 10, 1.1, '#8D9E76', .22)
  ctx.restore()
  ctx.restore()
}
function draw(ctx, menu, page, images = new Map(), font) {
  const lettering = createLettering(ctx, font)
  ctx.fillStyle = PAPER; ctx.fillRect(0,0,WIDTH,page.height)
  const rand = random(128)
  for (let n=0;n<6500;n++) {
    ctx.fillStyle = n%2 ? 'rgba(127,101,64,.026)' : 'rgba(255,255,255,.22)'
    ctx.fillRect(rand()*WIDTH, rand()*page.height, 1+rand()*2, .5+rand())
  }
  decoration(ctx,page.height)
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = INK
  ctx.font = 'italic 68px "Snell Roundhand", "Palatino", serif'; lettering.fillText('Menu',WIDTH/2,88)
  ctx.font = `23px ${handwriting}`
  page.titleLines.forEach((line,i)=>lettering.fillText(line,WIDTH/2,126+i*27))
  let y=126+(page.titleLines.length-1)*27
  ctx.fillStyle='#777766'; ctx.font='15px sans-serif'; lettering.fillText(`${menu.date.replace(/-/g,'.')} · ${menu.diners} 人`,WIDTH/2,y+26)
  ctx.font='13px sans-serif'; ctx.fillStyle='#6F8068'; lettering.fillText(menu.statusLabel,WIDTH/2,y+46)
  for (const photo of page.photos) {
    const image = images.get(photo.url)
    if (!image) continue
    const { x, y, size } = photo, radius = size / 2
    ctx.save()
    ellipse(ctx, x + radius, y + radius + 3, radius + 3, radius + 3, 0, '#D8D5BE', .6)
    ctx.beginPath(); ctx.arc(x + radius, y + radius, radius, 0, Math.PI * 2); ctx.clip()
    const side = Math.min(image.width, image.height)
    ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, x, y, size, size)
    ctx.restore()
  }
  ctx.textAlign = 'left'
  for (const block of page.blocks) {
    ctx.fillStyle = block.kind === 'category' ? INK : block.kind === 'note' ? '#7A816F' : '#3F5542'
    ctx.font = block.kind === 'category' ? `18px ${serif}` : block.kind === 'note' ? '15px sans-serif' : `23px ${handwriting}`
    ctx.textAlign = block.align || 'left'
    lettering.fillText(block.text, block.x, block.y)
    if (block.kind === 'category') {
      const half = lettering.measureText(block.text).width / 2 + 16
      if (half < 220) {
        ctx.strokeStyle = '#CED1BC'; ctx.lineWidth = 1; ctx.beginPath()
        ctx.moveTo(64, block.y - 7); ctx.lineTo(300 - half, block.y - 7)
        ctx.moveTo(300 + half, block.y - 7); ctx.lineTo(536, block.y - 7); ctx.stroke()
      }
    }
  }
  ctx.textAlign = 'center'

  ctx.font=`15px ${handwriting}`;ctx.fillStyle='#829078';lettering.fillText('好好吃饭 · 慢慢记住',300,page.height-43)
}
module.exports={ WIDTH, wrap, groupsFor, layout, draw, decoration }
