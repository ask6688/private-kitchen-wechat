// Run this source with playwright-cli run-code after starting the local documentation server.
async (page) => {
const ids = ['menu', 'wishes', 'meal', 'meal-detail', 'records', 'space', 'complete-menu']
for (const id of ids) {
  await page.setViewportSize({ width: 390, height: id === 'complete-menu' ? 500 : 844 })
  await page.goto(`http://127.0.0.1:8764/output/playwright/showcase/${id}.html`)
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  const problems = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > 390,
    brokenImages: [...document.images].filter(img => !img.complete || !img.naturalWidth).length,
    unresolved: document.body.textContent.includes('{{')
  }))
  if (problems.overflow || problems.brokenImages || problems.unresolved) throw new Error(`${id}: ${JSON.stringify(problems)}`)
  await page.screenshot({ path: `output/playwright/${id}.png`, fullPage: true, scale: 'css' })
  console.log(`${id}: rendered with demo data`)
}
}
