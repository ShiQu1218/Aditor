# templates/valorant/icons 範本來源

Valorant 的偵測不用圖片樣板，`profile.json` 只描述裁切區（`templates_version = valorant-feed@1`）：

- `banner`：右上擊殺列表（1920×1080 參考座標 1436,84 起、480×256，涵蓋 6 列）。
- `spec`：左下觀戰列，目前只會傳給錄影器做小圖，偵測時沒有用到。

判斷規則寫在 `engine/aditor/valorant.py`：
- 本機玩家頭像的黃框在列的哪一端，決定是擊殺還是死亡。
- 再看被殺者那一側的底色是哪一隊。

規則是用一支 1080p60 實況 VOD（3 場、計分板合計 53 殺 55 死）調出來的。
那支影片不是本專案擁有的素材，所以沒有放進 repo。
