import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { noticesFile, licenseFile } from './paths'

describe('license files ship with the installer (I11)', () => {
  const yml = fs.readFileSync(path.resolve(__dirname, '../../electron-builder.yml'), 'utf-8')
  it('electron-builder copies LICENSE and THIRD_PARTY_NOTICES.md into resources', () => {
    expect(yml).toMatch(/from:\s*\.\.\/LICENSE\s*\n\s*to:\s*LICENSE/)
    expect(yml).toMatch(/from:\s*\.\.\/THIRD_PARTY_NOTICES\.md\s*\n\s*to:\s*THIRD_PARTY_NOTICES\.md/)
  })
  it('the source files exist in the repo', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../../../LICENSE'))).toBe(true)
    expect(fs.existsSync(path.resolve(__dirname, '../../../THIRD_PARTY_NOTICES.md'))).toBe(true)
  })
  it('noticesFile resolves to resources when packaged and to the repo root in dev', () => {
    expect(noticesFile(false)).toBe(path.resolve(__dirname, '../../../THIRD_PARTY_NOTICES.md'))
    expect(licenseFile(false)).toBe(path.resolve(__dirname, '../../../LICENSE'))
    const rp = (process as unknown as { resourcesPath?: string }).resourcesPath
    ;(process as unknown as { resourcesPath?: string }).resourcesPath = 'C:/App/resources'
    try {
      expect(noticesFile(true)).toBe(path.join('C:/App/resources', 'THIRD_PARTY_NOTICES.md'))
    } finally {
      ;(process as unknown as { resourcesPath?: string }).resourcesPath = rp
    }
  })
})
