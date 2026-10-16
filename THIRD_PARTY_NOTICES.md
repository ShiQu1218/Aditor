# Third-Party Software Notices and Information

This project, Apex Highlighter, incorporates or interacts with several third-party open-source components and libraries. Below are the notices, attributions, and licensing details for those dependencies.

---

## 1. FFmpeg

- **License**: GNU Lesser General Public License (LGPL) version 2.1 or later (LGPL v3 / LGPL v2.1)
- **Source Code**: Available at [https://ffmpeg.org](https://ffmpeg.org) and [https://github.com/FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg)
- **Included Build**: Precompiled Windows 64-bit shared build provided by BtbN (`FFmpeg-Builds`).
- **Configuration (`ffmpeg -buildconf`)**:
  - The distributed build is strictly configured **WITHOUT** `--enable-gpl` and **WITHOUT** `--enable-nonfree`.
  - It includes `--enable-libdav1d` for high-performance AV1 video decoding.
  - It includes dynamic shared libraries (`avcodec`, `avformat`, `avutil`, etc.).
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

## 7. Cisco OpenH264 (Optional Download)

- **License**: Cisco Binary Code License Agreement
- **Source / Binary Provider**: Cisco Systems, Inc. ([http://ciscobinary.openh264.org](http://ciscobinary.openh264.org))
- **Notice**:
  Apex Highlighter does not bundle OpenH264 binaries by default. If the user chooses to enable precise H.264 re-encoding on systems without hardware encoders (NVENC / QSV / AMF), the application allows downloading the official precompiled binary directly from Cisco upon explicit user confirmation, ensuring compliance with Cisco's binary licensing model and patent royalty coverage.

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
Apex Highlighter is an independent open-source desktop utility designed for local gameplay video analysis. It is **not** affiliated with, endorsed, sponsored, or supported by Electronic Arts Inc., Respawn Entertainment, or any of their affiliates.
