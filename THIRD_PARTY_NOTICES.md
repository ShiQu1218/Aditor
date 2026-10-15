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

## 8. Disclaimer & Trademark Notice

*Apex Legends* is a registered trademark of Electronic Arts Inc.
Apex Highlighter is an independent open-source desktop utility designed for local gameplay video analysis. It is **not** affiliated with, endorsed, sponsored, or supported by Electronic Arts Inc., Respawn Entertainment, or any of their affiliates.
