"""Replace `- [ ]` with `- [x]` on the specified lines in a plan file. Usage: check.py <plan-file> <line...> (line ranges such as a-b are supported)."""
import sys

p = sys.argv[1]
lines = open(p, encoding="utf-8").read().split("\n")
for a in sys.argv[2:]:
    lo, _, hi = a.partition("-")
    for n in range(int(lo), int(hi or lo) + 1):
        lines[n - 1] = lines[n - 1].replace("- [ ]", "- [x]", 1)
open(p, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
