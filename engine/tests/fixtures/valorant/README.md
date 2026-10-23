# Compact player-row regression

`compact-player-row.png` is a 600×60 crop of the normalized kill-feed region at
the 33.25 s analysis sample of the user-provided recording:
`Playing Duelist Without Fear in Immortal.._1080p60.mp4`.

It occupies y=80..139 inside the 600×256 `BANNER_REF` crop. The new player kill is
slot 2. Its portrait is 22×24 px, yellow fill is about 64%, outline is 36 columns,
and row-edge contrast is 56.2. The original 40-column requirement misses it;
the same entry is first detected at 34.25 s after its outline becomes stronger.
The fixture contains only the HUD strip needed to reproduce that delay.

## Tracking and player-marker regressions

The following strips start at y=0 in the normalized 600×256 feed crop. They
retain only the HUD rows needed for the tests, excluding the face-camera region.
Times refer to the 4 FPS analysis grid; selected source frames are approximately
0.117 s later.

- `yellow-clothing-background.png` (600×60): LFT, 71.25 s. Killjoy kills Clove;
  yellow clothing plus bright scenery must not identify this as the POV kill.
- `outlined-player-background.png` (600×100): LFT, 64.75 s. Genuine POV kill of
  Sova, with an outlined portrait over bright scenery; must remain detectable.
- `faint-player-chevron.png` (600×100): LFT, 848.00 s. Genuine POV kill of
  Killjoy with a pale chevron. Rejecting sparse yellow components must not remove
  this event; the chevron's projected tip and outline provide independent support.
- `same-victim-after-cut.png` (600×60): Radiant Visual Guide, 177.25 s. A new
  kill of palkia after an empty feed must not attach to the earlier same-victim
  event at 170.75 s.
- `sparse-player-chevrons.png` (600×140): ASCENSION CN broadcast, 970.00 s.
  Two genuine outlined player rows with sparse yellow components must remain
  detectable. Their chevron tips distinguish them from a clothing stripe.
