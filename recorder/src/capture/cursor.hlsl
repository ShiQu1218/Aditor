cbuffer Cursor : register(b0) { int2 origin; uint kind; uint padding; float2 shapeSize; float2 drawSize; };
Texture2D<float4> pointerShape : register(t0);
Texture2D<float4> background : register(t1);
SamplerState linearClamp : register(s0);

float4 vertex(uint id : SV_VertexID) : SV_Position {
    float2 uv = float2((id << 1) & 2, id & 2);
    return float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}

float4 pixel(float4 position : SV_Position) : SV_Target {
    int2 p = int2(position.xy) - origin;
    float2 uv = (position.xy - origin) / drawSize;
    float4 cursor;
    if (all(shapeSize == drawSize)) cursor = pointerShape.Load(int3(p, 0));
    else if (kind == 2) cursor = pointerShape.SampleLevel(linearClamp, uv, 0);
    else cursor = pointerShape.Load(int3(int2(uv * shapeSize), 0));
    float4 dest = background.Load(int3(p, 0));
    if (kind == 2) return float4(cursor.rgb * cursor.a + dest.rgb * (1 - cursor.a), dest.a);
    uint3 rgb = (uint3)round(cursor.rgb * 255);
    uint3 screen = (uint3)round(dest.rgb * 255);
    uint mask = (uint)round(cursor.a * 255);
    uint3 result = kind == 1 ? ((screen & mask) ^ rgb) : (mask == 255 ? (screen ^ rgb) : rgb);
    return float4(float3(result) / 255, dest.a);
}
