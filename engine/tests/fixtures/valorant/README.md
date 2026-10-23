# Compact player-row regression

`compact-player-row.png` is a 600×60 crop of the normalized kill-feed region at
the 33.25 s analysis sample of the user-provided recording:
`Playing Duelist Without Fear in Immortal.._1080p60.mp4`.

It occupies y=80..139 inside the 600×256 `BANNER_REF` crop. The new player kill is
slot 2. Its portrait is 22×24 px, yellow fill is about 64%, outline is 36 columns,
and row-edge contrast is 56.2. The original 40-column requirement misses it;
the same entry is first detected at 34.25 s after its outline becomes stronger.
The fixture contains only the HUD strip needed to reproduce that delay.
