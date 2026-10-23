# Third-Party Software Notices and Information

This project, Aditor, incorporates or interacts with several third-party open-source components and libraries. Below are the notices, attributions, and licensing details for those dependencies.

---

## 1. FFmpeg

- **License**: GNU Lesser General Public License, **version 3** (LGPL v3). The bundled build is configured with `--enable-version3` and **without** `--enable-gpl` and **without** `--enable-nonfree`, so the combined FFmpeg libraries are licensed under LGPL v3 (not "v2.1 or later"). The full license text ships as `resources/ffmpeg/LICENSE.txt`.
- **Source Code**: [FFmpeg](https://ffmpeg.org) at commit [`46d899d7a02bc63237472cc4897258d5ddf274ac`](https://github.com/FFmpeg/FFmpeg/tree/46d899d7a02bc63237472cc4897258d5ddf274ac) (`n8.1.3-18-g46d899d7a0`, 18 commits after release 8.1.3 on release/8.1). The exact build scripts and pinned dependency sources are published in [Aditor-FFmpeg, recipe commit `9fdbff2a8a5ce16285b9cdefdb72bc658067209b`](https://github.com/ShiQu1218/Aditor-FFmpeg/tree/9fdbff2a8a5ce16285b9cdefdb72bc658067209b), based on [BtbN/FFmpeg-Builds commit `63ac3265b0789ea16c7b1f8351cd2ad195a28722`](https://github.com/BtbN/FFmpeg-Builds/tree/63ac3265b0789ea16c7b1f8351cd2ad195a28722).
- **Included Build**: Windows 64-bit minimal **shared** build `ffmpeg-46d899d-win64-lgpl-shared-aditor-8.1.zip` from [Aditor-FFmpeg release `aditor-8.1-20261023.1`](https://github.com/ShiQu1218/Aditor-FFmpeg/releases/tag/aditor-8.1-20261023.1). The exact tag and SHA-256 are pinned in `scripts/fetch-ffmpeg.ps1`, which refuses a checksum mismatch. NVENC headers remain pinned to SDK 13.0.
- **Configuration (`ffmpeg -buildconf`)**:
  - `--enable-version3`, no `--enable-gpl`, no `--enable-nonfree`.
  - Remaining third-party dependencies: dav1d (AV1 decoding), OpenH264 (see section 7), AMF headers, nv-codec-headers (SDK 13.0), libvpl (Intel QSV), and zlib (native PNG decoding). Opus, Vorbis, MP3, FLAC, AC-3 and PCM decoding use FFmpeg's built-in implementations. libaom, libvpx, libopus, libvorbis, libass, libwebp, libsvtav1, rav1e and other general-purpose build dependencies are not bundled.
  - `--disable-everything --disable-network --disable-autodetect`, followed by the required components from the published JSON manifest. Only `file` and `pipe` protocols are enabled; x86 assembly remains enabled. The complete generated arguments, component manifest and build recipe commit ship under `resources/ffmpeg/build-config/`. Dependency license texts and fixed source coordinates ship under `resources/ffmpeg/third-party-licenses/`; the release ZIP additionally includes the actual configure-generated headers and recipe.
  - FFmpeg is linked dynamically (`avcodec`, `avformat`, `avutil`, ... DLLs), as a separate executable that Aditor launches as a child process.
- **User Modification Notice**:
  In compliance with the LGPL, users have the right to modify, recompile, or replace the FFmpeg shared libraries and executable binaries. You may replace the files in the `resources/ffmpeg/` directory with any binary-compatible FFmpeg build of your choice.

---

## 2. dav1d

- **License**: BSD 2-Clause License
- **Copyright**: (c) 2018–2026, VideoLAN and dav1d authors.
- **Description**: Fast and lightweight AV1 decoder used via FFmpeg.

---

## 3. OpenCV (Open Source Computer Vision Library)

- **License**: Apache License 2.0
- **Copyright**: (c) 2000–2026, OpenCV Foundation, Intel Corporation, and contributors.
- **Source**: [https://opencv.org](https://opencv.org)

---

### 3a. OpenCV bundled FFmpeg (opencv_videoio_ffmpeg)

- The Python wheel of OpenCV includes `cv2/opencv_videoio_ffmpeg*.dll`, an FFmpeg build licensed under **LGPL v2.1 or later** (source: [https://github.com/opencv/opencv-python](https://github.com/opencv/opencv-python) and [https://ffmpeg.org](https://ffmpeg.org)). Aditor excludes this unused OpenCV video I/O DLL from the packaged engine; frames are decoded by the separate FFmpeg described in section 1.

### 3b. Python and PyInstaller

- The analysis engine is packaged with PyInstaller (GPL v2 or later **with a special exception** that permits distributing the bootloader and bundled applications under any license) and embeds the CPython runtime (Python Software Foundation License, [https://docs.python.org/3/license.html](https://docs.python.org/3/license.html)).

---

## 4. NumPy

- **License**: BSD 3-Clause License
- **Copyright**: (c) 2005–2026, NumPy Developers.
- **Source**: [https://numpy.org](https://numpy.org)

---

## 5. Electron & Chromium

- **License**: MIT License (Electron) and BSD-style licenses (Chromium).
- **Copyright**: (c) Electron contributors; (c) The Chromium Authors.
- **Source**: [https://www.electronjs.org](https://www.electronjs.org)

---

## 6. React

- **License**: MIT License
- **Copyright**: (c) Meta Platforms, Inc. and affiliates.
- **Source**: [https://react.dev](https://react.dev)

---

## 7. OpenH264 (H.264 encoder)

- **License of the source code**: BSD 2-Clause License. Copyright (c) 2013, Cisco Systems, Inc.
- **What is bundled**: The bundled FFmpeg build (section 1) is compiled with `--enable-libopenh264`; Aditor's FFmpeg fork inherits BtbN's pinned recipe to build OpenH264 from source and link it into FFmpeg. This is **not** Cisco's pre-built binary, so Cisco's patent license for its own binary release (Cisco Binary Code License, [http://www.openh264.org/BINARY_LICENSE.txt](http://www.openh264.org/BINARY_LICENSE.txt)) does **not** cover the encoder inside the bundled FFmpeg.
- **Optional download**: When the user chooses precise H.264 re-encoding on a system without a hardware encoder (NVENC / QSV / AMF), the application can download Cisco's official pre-built OpenH264 binary directly from Cisco after explicit user confirmation. That binary is covered by Cisco's Binary Code License and patent grant; it is not redistributed with the installer.
- **Patents**: H.264 is subject to patent licensing (MPEG LA / Via LA). Aditor is a local, non-commercial desktop utility; anyone redistributing builds commercially is responsible for obtaining the necessary H.264 patent licenses or for substituting an FFmpeg build compiled with `--disable-libopenh264`.

---

## 8. Lato and Montserrat (Bundled Fonts)

- **License**: SIL Open Font License, Version 1.1 (OFL-1.1) — full text below.
- **Files**: Latin-subset woff2 files (Lato Regular/Bold, Montserrat Bold/Black), copied unmodified from the npm packages `@fontsource/lato` 5.3.0 and `@fontsource/montserrat` 5.3.0, under `app/src/renderer/assets/fonts/`. CJK text uses system fonts; nothing is downloaded at runtime.
- **Lato**: Copyright (c) 2010-2011 by tyPoland Lukasz Dziedzic (team@latofonts.com) with Reserved Font Name "Lato". Licensed under the SIL Open Font License, Version 1.1.
- **Montserrat**: Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat).

```text
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

---

## 9. Disclaimer & Trademark Notice

*Apex Legends* is a registered trademark of Electronic Arts Inc.
*VALORANT* and Riot Games are trademarks or registered trademarks of Riot Games, Inc.
Aditor is an independent open-source desktop utility designed for local gameplay video analysis. It is **not** affiliated with, endorsed, sponsored, or supported by Electronic Arts Inc., Respawn Entertainment, Riot Games, Inc., or any of their affiliates.
