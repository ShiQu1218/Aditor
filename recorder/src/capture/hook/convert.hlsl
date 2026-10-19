// Convert shared game-capture texture formats using a fullscreen triangle generated with SV_VertexID.
// Hardware handles channel ordering and bit-depth conversion through UNORM SRV reads and BGRA RTV output.

Texture2D<float4> src : register(t0);

float4 vs_main(uint id : SV_VertexID) : SV_Position {
    float2 uv = float2((id << 1) & 2, id & 2);
    return float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}

float4 ps_main(float4 pos : SV_Position) : SV_Target {
    return src.Load(int3(pos.xy, 0));
}

float4 ps_bgrx(float4 pos : SV_Position) : SV_Target {
    return float4(src.Load(int3(pos.xy, 0)).rgb, 1.0);
}
