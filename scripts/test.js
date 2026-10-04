// Run each assertion suite in a fresh process so mocked WeChat globals stay isolated.
const { readdirSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const root = join(__dirname, '..')
const suites = ['cloudfunctions/kitchen/test.js', ...readdirSync(join(root, 'tests')).filter(name => name.endsWith('.js')).sort().map(name => `tests/${name}`)]
let failed = 0
for (const suite of suites) {
  const result = spawnSync(process.execPath, [join(root, suite)], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    if (result.error) console.error(result.error.message)
    failed++; console.error(`FAIL ${suite}`); continue
  }
  console.log(`PASS ${suite}`)
}
console.log(`${suites.length - failed}/${suites.length} suites passed`)
process.exitCode = failed ? 1 : 0
