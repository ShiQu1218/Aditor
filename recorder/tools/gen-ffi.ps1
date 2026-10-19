param([string]$FFmpegDir = $env:ADITORREC_FFMPEG_DIR)
# 重建需求：cargo install bindgen-cli --version 0.73.2 --locked，及 LLVM libclang。
$ErrorActionPreference = 'Stop'
if (-not $FFmpegDir) { $FFmpegDir = Join-Path $PSScriptRoot '../../build/ffmpeg' }
$env:LIBCLANG_PATH = 'C:/Program Files/LLVM/bin'
$header = Join-Path ([IO.Path]::GetTempPath()) ('aditorrec-' + [guid]::NewGuid() + '.h')
try {
    @'
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_d3d11va.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/imgutils.h>
'@ | Set-Content -LiteralPath $header -Encoding ascii
    $functions = 'avcodec_(version|find_encoder_by_name|alloc_context3|open2|free_context|send_frame|receive_packet|parameters_from_context)|avutil_version|av_(strerror|buffer_ref|buffer_unref|buffer_get_ref_count|frame_alloc|frame_clone|frame_free|frame_get_buffer|packet_alloc|packet_free|packet_rescale_ts|hwdevice_ctx_alloc|hwdevice_ctx_init|hwdevice_ctx_create_derived|hwframe_ctx_alloc|hwframe_ctx_init|hwframe_ctx_create_derived|hwframe_get_buffer|hwframe_map|opt_set|dict_set|dict_free|channel_layout_default|audio_fifo_alloc|audio_fifo_free|audio_fifo_write|audio_fifo_read|audio_fifo_size|malloc|free)|avformat_(version|alloc_output_context2|new_stream|write_header|free_context)|av_write_(frame|trailer)|avio_(alloc_context|context_free|flush)'
    $variables = 'AV_(PIX_FMT_(D3D11|BGRA|NV12)|HWDEVICE_TYPE_D3D11VA|MEDIA_TYPE_(VIDEO|AUDIO)|SAMPLE_FMT_(FLT|FLTP)|PICTURE_TYPE_(NONE|I)|PKT_FLAG_KEY|FMT_FLAG_CUSTOM_IO|FMT_NOFILE|ERROR_EOF|NOPTS_VALUE)|AV_CODEC_FLAG_GLOBAL_HEADER|LIBAV(CODEC|FORMAT|UTIL)_VERSION_MAJOR'
    & bindgen $header --output (Join-Path $PSScriptRoot '../src/encode/ffi.rs') `
        --allowlist-function $functions --allowlist-var $variables --allowlist-var 'AVFMT_FLAG_CUSTOM_IO|AV_HWFRAME_MAP_READ' `
        --allowlist-type 'AVHW(Device|Frames)Context|AVD3D11VA(Device|Frames)Context|AVClass|ID3D11(Device|DeviceContext|VideoDevice|VideoContext|Texture2D)' `
        --opaque-type 'ID3D11.*|IUnknown|AVCodec|AVInputFormat|AVOutputFormat|AVClass' `
        --no-layout-tests --no-doc-comments --no-prepend-enum-name `
        --raw-line '#![allow(non_camel_case_types, non_snake_case, non_upper_case_globals, dead_code, clippy::all)]' `
        -- -I "$FFmpegDir/include"
    if ($LASTEXITCODE -ne 0) { throw 'bindgen 產生失敗' }
    & rustfmt --edition 2021 (Join-Path $PSScriptRoot '../src/encode/ffi.rs')
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg 綁定格式化失敗' }
} finally {
    Remove-Item -LiteralPath $header -ErrorAction SilentlyContinue
}
