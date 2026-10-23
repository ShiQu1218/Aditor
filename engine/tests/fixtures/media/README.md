# Synthetic AV1 decoding fixture

`av1-1s-640x360-60.mp4` is generated entirely from FFmpeg's `testsrc2` source. It contains no user footage or audio. Keeping this tiny input allows AV1 decoding and hardware-fallback tests to run without shipping an AV1 software encoder.

Generated with development FFmpeg 8.1.1 / SVT-AV1 4.1.0:

```powershell
ffmpeg -v error -y -f lavfi -i testsrc2=size=640x360:rate=60:duration=1 -c:v libsvtav1 -preset 12 -g 60 -pix_fmt yuv420p av1-1s-640x360-60.mp4
```

Properties: AV1 Main, 8-bit YUV420, 640×360, 60 frames at 60 fps, 1 second.

SHA256: `920503EA77FD919F3AA2DC85368393383C035990BF9A2585D8763AFD1F34DF6E`.
