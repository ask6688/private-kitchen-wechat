// Run this source with playwright-cli run-code after starting the local documentation server.
async (page) => {
const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })
const shot = await context.newPage()
const ids = ['menu', 'wishes', 'meal', 'meal-detail', 'records', 'space', 'complete-menu']
try {
for (const id of ids) {
  await shot.setViewportSize({ width: 390, height: id === 'complete-menu' ? 500 : 844 })
  await shot.goto(`http://127.0.0.1:8764/output/playwright/showcase/${id}.html`)
  await shot.waitForFunction(() => document.body.dataset.ready === 'true')
  const problems = await shot.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > 390,
    brokenImages: [...document.images].filter(img => !img.complete || !img.naturalWidth).length,
    unresolved: document.body.textContent.includes('{{')
  }))
  if (problems.overflow || problems.brokenImages || problems.unresolved) throw new Error(`${id}: ${JSON.stringify(problems)}`)
  await shot.screenshot({ path: `output/playwright/${id}.png`, fullPage: id === 'complete-menu', scale: 'device' })
  console.log(`${id}: rendered with demo data`)
}
} finally { await context.close() }
}
