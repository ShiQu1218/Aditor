Texture2D<float4> source : register(t0);
cbuffer Levels : register(b0) { float white; float hdr; float2 padding; };

float4 vertex(uint id : SV_VertexID) : SV_Position {
    return float4(id == 2 ? 3 : -1, id == 1 ? 3 : -1, 0, 1);
}

float4 pixel(float4 position : SV_Position) : SV_Target {
    // scRGB is linear, with 1.0 = 80 nits. Normalize Windows' SDR white first.
    float3 rgb = max(source.Load(int3(position.xy, 0)).rgb / white, 0);
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
