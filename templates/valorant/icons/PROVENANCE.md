# templates/valorant/icons 範本來源

Valorant 的偵測不用圖片樣板，`profile.json` 只描述裁切區（`templates_version = valorant-feed@3`）：

- `banner`：右上擊殺列表（1920×1080 參考座標 1316,84 起、600×256，涵蓋 6 列；名字很長的列左端會延伸到 x≈1428）。
- `spec`：上方比分列（740,20 起、460×64），用來判斷回合（`engine/aditor/valorant_rounds.py`）。寬度不能超過 `banner`，因為解碼時會把它補到同寬。

判斷規則寫在 `engine/aditor/valorant.py`：
- 本機玩家那一列的黃色標記在哪一端，決定是擊殺還是死亡。標記有兩種樣式：實心黃色頭像框（2026-10 的實況 VOD），以及外側的黃色箭頭加上一圈細黃框（13.08 版客戶端的錄影）。
- 再看被殺者那一側的底色是哪一隊。

規則是用一支 1080p60 實況 VOD（3 場、計分板合計 53 殺 55 死）調出來的。
那支影片不是本專案擁有的素材，所以沒有放進 repo。
