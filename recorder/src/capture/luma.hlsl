// 對 320×180 thumb 計算整數灰階總和；只讀回一個 u32，不重複讀回完整小圖。
Texture2D<float4> thumb : register(t0);
RWStructuredBuffer<uint> result : register(u0);
groupshared uint partial[256];

[numthreads(256, 1, 1)]
void main(uint index : SV_GroupIndex) {
    uint sum = 0;
    for (uint pixel = index; pixel < 320 * 180; pixel += 256) {
        uint3 rgb = (uint3)round(thumb.Load(int3(pixel % 320, pixel / 320, 0)).rgb * 255.0);
        sum += (299 * rgb.r + 587 * rgb.g + 114 * rgb.b) / 1000;
    }
    partial[index] = sum;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = 128; stride > 0; stride /= 2) {
        if (index < stride) partial[index] += partial[index + stride];
        GroupMemoryBarrierWithGroupSync();
    }
    if (index == 0) result[0] = partial[0];
}
