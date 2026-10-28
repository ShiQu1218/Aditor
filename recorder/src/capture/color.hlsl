Texture2D<float4> source : register(t0);
SamplerState linearClamp : register(s0);
cbuffer Levels : register(b0) { float white; float hdr; float2 footprint; };

float4 vertex(uint id : SV_VertexID) : SV_Position {
    return float4(id == 2 ? 3 : -1, id == 1 ? 3 : -1, 0, 1);
}

float4 pixel(float4 position : SV_Position) : SV_Target {
    // scRGB is linear, with 1.0 = 80 nits. Normalize Windows' SDR white first.
    uint width, height;
    source.GetDimensions(width, height);
    float2 first = (position.xy - 0.5) * footprint;
    float2 last = min(first + footprint, float2(width, height));
    float3 sum = 0;
    float weight = 0;
    // Pair adjacent texels in bilinear taps with exact pixel-area weights.
    for (float y = floor(first.y); y < ceil(last.y); y += 2) {
        float2 wy = max(min(last.y, float2(y + 1, y + 2)) - max(first.y, float2(y, y + 1)), 0);
        for (float x = floor(first.x); x < ceil(last.x); x += 2) {
            float2 wx = max(min(last.x, float2(x + 1, x + 2)) - max(first.x, float2(x, x + 1)), 0);
            float2 total = float2(wx.x + wx.y, wy.x + wy.y);
            float2 uv = (float2(x, y) + 0.5 + float2(wx.y, wy.y) / total) / float2(width, height);
            float area = total.x * total.y;
            sum += source.SampleLevel(linearClamp, uv, 0).rgb * area;
            weight += area;
        }
    }
    float3 rgb = max(sum / weight / white, 0);
    // Scale all channels together to preserve hue while compressing HDR highlights.
    float peak = max(rgb.r, max(rgb.g, rgb.b));
    if (hdr > 0 && peak > 0.75) {
        float mapped = 0.75 + 0.25 * (peak - 0.75) / (peak - 0.5);
        rgb *= mapped / peak;
    }
    float3 srgb = lerp(1.055 * pow(rgb, 1.0 / 2.4) - 0.055,
                      12.92 * rgb, rgb <= 0.0031308);
    return float4(saturate(srgb), 1);
}
