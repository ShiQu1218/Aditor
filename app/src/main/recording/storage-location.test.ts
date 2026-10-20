import { describe, expect, it } from 'vitest'
import { classifyStorage, cloudSyncRoots, parseVolumeInfo } from './storage-location'

const LOCAL = { driveType: 3, volumeName: 'Data', providerName: '' }

describe('recording storage classification', () => {
  it('collects sync roots from OneDrive variables, Dropbox info, and default cloud folders', () => {
    const roots = cloudSyncRoots({ OneDrive: 'C:\\Users\\a\\OneDrive', OneDriveCommercial: 'C:\\Users\\a\\OneDrive - Org' },
      'C:\\Users\\a', ['E:\\Dropbox'])
    expect(roots).toEqual(expect.arrayContaining(['C:\\Users\\a\\OneDrive', 'C:\\Users\\a\\OneDrive - Org', 'E:\\Dropbox',
      'C:\\Users\\a\\Dropbox', 'C:\\Users\\a\\iCloudDrive', 'C:\\Users\\a\\Google Drive']))
  })

  it('treats folders inside a sync root as cloud storage, case-insensitively, without matching sibling prefixes', () => {
    const roots = ['C:\\Users\\a\\OneDrive']
    expect(classifyStorage('c:\\users\\A\\onedrive\\Videos\\Apex', roots, LOCAL)).toBe('cloud')
    expect(classifyStorage('C:\\Users\\a\\OneDrive', roots, LOCAL)).toBe('cloud')
    expect(classifyStorage('C:\\Users\\a\\OneDriveBackup\\Apex', roots, LOCAL)).toBeNull()
  })

  it('treats mapped network drives as network storage and cloud-labelled volumes as cloud storage', () => {
    expect(classifyStorage('Z:\\Apex', [], { driveType: 4, volumeName: '', providerName: '\\\\nas\\video' })).toBe('network')
    expect(classifyStorage('G:\\電腦程式\\Apex', [], { driveType: 3, volumeName: 'Google Drive', providerName: '' })).toBe('cloud')
    expect(classifyStorage('G:\\電腦程式\\Apex', [], LOCAL)).toBeNull()
    expect(classifyStorage('D:\\Apex', [], null)).toBeNull()
  })

  it('parses PowerShell CIM JSON and rejects malformed output', () => {
    expect(parseVolumeInfo('{"DriveType":4,"VolumeName":null,"ProviderName":"\\\\\\\\nas\\\\v"}'))
      .toEqual({ driveType: 4, volumeName: '', providerName: '\\\\nas\\v' })
    expect(parseVolumeInfo('')).toBeNull()
    expect(parseVolumeInfo('not json')).toBeNull()
    expect(parseVolumeInfo('{"DriveType":"x"}')).toBeNull()
  })
})
