# -*- mode: python ; coding: utf-8 -*-
import sys
from pathlib import Path

block_cipher = None

engine_dir = Path(SPECPATH).resolve()

a = Analysis(
    [str(engine_dir / 'aditor' / '__main__.py')],
    pathex=[str(engine_dir)],
    binaries=[],
    datas=[],
    hiddenimports=[
        'cv2',
        'numpy',
        'bz2',
        'aditor',
        'aditor.analyze',
        'aditor.autoclip',
        'aditor.cache',
        'aditor.calibrate',
        'aditor.decode',
        'aditor.diagnostics',
        'aditor.derive',
        'aditor.detect',
        'aditor.errors',
        'aditor.events',
        'aditor.ffbin',
        'aditor.icon_detect',
        'aditor.ipc',
        'aditor.models',
        'aditor.probe',
        'aditor.profile'
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'scipy'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='aditor',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='aditor',
)
