# Battle Royale false-Control regression crops

`br_271_25_hud.png` is the top 90 rows of the restored kill-feed ROI
(x=850, y=60, width=1070) from `Apex_2026-10-19_16-50.mp4` at the
analyzer's 271.25 s sample (`fps=4`; the selected source frame is later than
an exact seek to 271.25 s). Its compass and scenery match `control_objectives`
at 0.803041220 (above the 0.8 threshold) despite the visible Battle Royale
kill and assist counters.

`br_506_hud.png` is the same crop from the analyzer's 506 s sample in that video,
where the full frame also shows a Battle Royale knock banner. Both crops
retain the two counter icons (including the kill-leader skull at 506 s) and
exclude player names and feed entries.
Tests pad the omitted rows with black before calling `ControlFeed.feed`.

`br_inventory_236_hud.png` is the same ROI crop at the 236 s sample from
`Apex_2026-10-19_17-41.mp4`, captured from the Rust decoder. It scores
0.808073044 against the objectives template while the inventory is open.
`br_inventory_236_thumb.png` is its 640x360 grayscale scene thumbnail.
These exercise the non-HUD activation guard when BR counters are hidden.

All four PNGs together total less than 1 MB. Existing frozen oracle entries
remain unchanged; these new cases intentionally reject Python's inherited
false-Control behavior.

## Japanese Control and Gun Run

`ja_control_{feed,spec}.png`: `Apex_2026-10-29_16-26.mp4`, 140 s.
Two blue `shiqu030` weapon kills against orange victims.
`ja_gunrun_{feed,spec}.png`: `Apex_2026-10-29_15-54.mp4`, 350 s.
The damage counter must disarm Control without suppressing central kill banners.
Both use normalized 1920x1080 feed `(850,60,1070,420)` and spec `(60,950,480,118)` crops.
