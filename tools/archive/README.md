# Archived Python engine tools

These scripts target the removed Python engine (last present at commit `c30dddf`)
and are unmaintained. `parity/` holds the reference fixture exporters; `icon_exp/`
holds the icon detector experiments. They are not production dependencies.

To run them, restore the Python engine and original script paths in a separate
checkout from git history, and use the matching reference environment. Moving
these files did not update their historical imports or relative paths.
