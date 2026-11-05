#!/usr/bin/env node

import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdir } from 'fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const srcDir = join(__dirname, '../src')
const outputDir = join(__dirname, '../build')

await mkdir(outputDir, { recursive: true })

const modules = [
  {
    name: 'service-worker',
    input: join(srcDir, 'service-worker.ts'),
    output: join(outputDir, '../extension/js/serviceWorker/bundle.js')
  },
  {
    name: 'browser',
    input: join(srcDir, 'browser.ts'),
    output: join(outputDir, '../extension/js/browser/bundle.js')
  }
]

try {
  for (const module of modules) {
    await esbuild.build({
      entryPoints: [module.input],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2021',
      outfile: module.output,
      sourcemap: true,
      resolveExtensions: ['.mts', '.ts', '.js', '.mjs'],
      mainFields: ['module', 'main'],
      conditions: ['import', 'module', 'default'],
      define: {
        'chrome': 'globalThis.chrome'
      }
    })

    console.log(`bundle created: ${module.output}`)
  }
} catch (error) {
  console.error('build failed:', error)
  process.exit(1)
}
