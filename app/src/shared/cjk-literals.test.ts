import { expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const SRC = path.resolve(__dirname, '..')
const SKIP_DIRS = new Set(['messages', 'i18n', 'e2e', 'dev'])
const CJK = /[\u4e00-\u9fff]/

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(full)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== 'locale.ts' ? [full] : []
  })
}

function insideTranslation(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'tr') return true
  }
  return false
}

it('routes CJK string literals through tr()', () => {
  const violations: string[] = []
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const relative = path.relative(SRC, file).replace(/\\/g, '/')
    const lines = text.split(/\r?\n/)
    function visit(node: ts.Node): void {
      // The parser excludes comments and distinguishes literals from regular expressions and JSX text.
      const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      const template = ts.isTemplateExpression(node)
      const value = literal ? node.text : template ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('') : ''
      if (CJK.test(value) && !insideTranslation(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        // This keyword matches searches in the source language; it is not displayed.
        const searchKeyword = relative === 'renderer/settings/rows.ts' && value === '\u9304\u5f71'
        // WatchManager.warnOnce only forwards messages to console.warn.
        const watchLog = relative === 'main/watch.ts' && ts.isCallExpression(node.parent)
          && ts.isPropertyAccessExpression(node.parent.expression)
          && node.parent.expression.expression.kind === ts.SyntaxKind.ThisKeyword
          && node.parent.expression.name.text === 'warnOnce'
        if (!searchKeyword && !watchLog && !/\bconsole\s*\./.test(lines[line])) {
          violations.push(`${relative}:${line + 1}: ${node.getText(source)}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(violations).toEqual([])
})
