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

`ja_yellow_{feed,spec}.png`: `Apex_2026-10-29_18-32.mp4`, 599.25 s.
The local player `shiqu030` has a yellow feed name, with one weapon kill against
an orange victim among other players' kills. Actor identity and victim/weapon
validation must still exclude those unrelated rows.
The test also converts just the player's name to grayscale and black/white,
keeping the victim and weapon unchanged, to verify color-independent localization.
`ja_yellow_notice_feed.png`: 235.75 s in the same recording. The rating-leader
announcement repeats the local player's name above one actual weapon kill;
only the weapon row counts. Whole-feed/HUD grayscale variants of the Traditional
Chinese and Japanese crops are also checked without retaining any hue channels.
`ja_short_victim_{early,late}.png`: feed rows from 321.5 s (`y=148,h=32`) and
327.75 s (`y=212,h=32`) of that recording. The same victim `a` moves down the
feed while the background becomes bright. Panel padding must not replace the
victim glyph or create a second kill. Tests pad the omitted rows with black.
`ja_melee_row.png` and `ja_melee_spec.png`: 345.5 s in `Apex_2026-10-29_17-49.mp4`.
The feed row (`y=148,h=32`) has a faint local name followed by the bracketed melee
marker. Both the original crop and its grayscale variant must count that kill.

`ja_control_{feed,spec}.png`: `Apex_2026-10-29_16-26.mp4`, 140 s.
Two blue `shiqu030` weapon kills against orange victims.
`ja_gunrun_{feed,spec}.png`: `Apex_2026-10-29_15-54.mp4`, 350 s.
The damage counter must disarm Control without suppressing central kill banners.
Both use normalized 1920x1080 feed `(850,60,1070,420)` and spec `(60,950,480,118)` crops.

## Muted pink player feed (2026-10-29)

`ja_muted_{feed,spec}.png`: `Apex_2026-10-29_17-49.mp4`, 240 s, same normalized ROIs.
The local player's feed name is muted pink; cyan and blue masks miss it.
`pink_trace/trace.json` and its grayscale signatures retain every 4 fps observation from
345–364.75 s of the same video, including empty observations. Each PNG is a 400x24
victim signature after the existing color mask and normalization (rounded to 8-bit).
The melee kill at 345 s must not be counted again as its glyphs shift during fade;
the different victim at 359.25 s must still count.

`pink_late_trace/` similarly preserves 657–684.75 s: a 2.5-second loss of the dim actor
name while the original victim stays visible must not create a second kill. The same
victim killed again at 681.5 s must count after the earlier entry has expired.
