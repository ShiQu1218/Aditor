"""zoom.py LAB t x0 y0 x1 y1 out [k]: enlarge a crop and draw a 10 px grid for reading coordinates."""
import sys
from fr import *
lab, t, x0, y0, x1, y1, out = sys.argv[1], float(sys.argv[2]), *map(int, sys.argv[3:7]), sys.argv[7]
k = int(sys.argv[8]) if len(sys.argv) > 8 else 4
im = np.ascontiguousarray(load(lab)[idx(t)][y0:y1, x0:x1])
big = cv2.resize(im, None, fx=k, fy=k, interpolation=cv2.INTER_NEAREST)
for x in range(0, x1 - x0, 10):
    big[:, x * k] = (0, 255, 0) if (x0 + x) % 50 == 0 else (0, 90, 0)
for y in range(0, y1 - y0, 10):
    big[y * k, :] = (0, 255, 0) if (y0 + y) % 50 == 0 else (0, 90, 0)
cv2.imwrite(str(SP / out), big)
print("grid origin", x0, y0)
