Texture2D<float> luma : register(t0);
Texture2D<float2> chroma : register(t1);
Texture2D<float4> work : register(t2);
cbuffer Params : register(b0) { float2 sourceSize; float2 outputSize; };

float4 vertex(uint id : SV_VertexID) : SV_Position {
    return float4(id == 2 ? 3 : -1, id == 1 ? 3 : -1, 0, 1);
}

float4 loadPixel(float4 position : SV_Position) : SV_Target {
    float3 x = work.Load(int3(position.xy, 0)).rgb + float3(0.123, 0.456, 0.789);
    [loop] for (uint i = 0; i < 128; ++i) {
        x = frac(x.yzx * float3(1.971, 1.983, 1.997) + x.zxy * 0.127 + 0.013);
    }
    return float4(x, 1);
}

float4 pixel(float4 position : SV_Position) : SV_Target {
    int2 p = min(int2(position.xy * sourceSize / outputSize), int2(sourceSize) - 1);
    float y = (luma.Load(int3(p, 0)) - 16.0 / 255.0) * (255.0 / 219.0);
    float2 uv = (chroma.Load(int3(uint2(p) / 2u, 0)) - 128.0 / 255.0) * (255.0 / 224.0);
    float3 rgb = float3(y + 1.5748 * uv.y, y - 0.187324 * uv.x - 0.468124 * uv.y, y + 1.8556 * uv.x);
    // Keep every load pass observable while preserving HUD readability.
    return float4(saturate(rgb + work.Load(int3(position.xy, 0)).rgb / 1024.0), 1);
}
