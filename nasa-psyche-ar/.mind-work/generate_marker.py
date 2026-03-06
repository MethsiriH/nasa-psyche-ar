from pathlib import Path

import cv2
import numpy as np

repo_root = Path(__file__).resolve().parents[1]
out_dir = repo_root / "public" / "markers"
out_dir.mkdir(parents=True, exist_ok=True)

marker_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_1000)
marker_id = 0

png_size = 600
png = cv2.aruco.generateImageMarker(marker_dict, marker_id, png_size)
png_path = out_dir / "4x4_1000-0.png"
cv2.imwrite(str(png_path), png)

grid_size = 6
grid = cv2.aruco.generateImageMarker(marker_dict, marker_id, grid_size)
cell_size = 100
svg_size = grid_size * cell_size

svg_lines = [
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{svg_size}" height="{svg_size}" viewBox="0 0 {svg_size} {svg_size}">',
    f'<rect width="{svg_size}" height="{svg_size}" fill="white"/>',
]

for y in range(grid_size):
    for x in range(grid_size):
        if int(grid[y, x]) < 128:
            svg_lines.append(
                f'<rect x="{x * cell_size}" y="{y * cell_size}" width="{cell_size}" height="{cell_size}" fill="black"/>'
            )

svg_lines.append("</svg>")
svg_path = out_dir / "4x4_1000-0.svg"
svg_path.write_text("\n".join(svg_lines), encoding="utf-8")

print(f"Generated: {png_path}")
print(f"Generated: {svg_path}")

# Build a feature-rich MindAR target image with the ArUco marker in the center.
# MindAR tracks natural image features better than plain binary fiducials.
target_size = 1400
target = np.full((target_size, target_size, 3), 255, dtype=np.uint8)

# Outer frame.
cv2.rectangle(target, (60, 60), (target_size - 60, target_size - 60), (0, 0, 0), 20)

# Checker ring to provide strong corners.
ring_cells = 12
ring_span = target_size - 240
cell = ring_span // ring_cells
origin = (target_size - ring_span) // 2
for y in range(ring_cells):
    for x in range(ring_cells):
        is_border = x in (0, ring_cells - 1) or y in (0, ring_cells - 1)
        if not is_border:
            continue
        if (x + y) % 2 == 0:
            x0 = origin + x * cell
            y0 = origin + y * cell
            cv2.rectangle(target, (x0, y0), (x0 + cell, y0 + cell), (0, 0, 0), -1)

# Deterministic micro-features around the center.
rng = np.random.default_rng(42)
for _ in range(120):
    px = int(rng.integers(180, target_size - 180))
    py = int(rng.integers(180, target_size - 180))
    if 460 < px < 940 and 460 < py < 940:
        continue
    radius = int(rng.integers(4, 10))
    color = (0, 0, 0) if rng.integers(0, 2) == 0 else (50, 50, 50)
    cv2.circle(target, (px, py), radius, color, -1)

# Center ArUco marker with white quiet zone.
aruco_size = 620
aruco = cv2.aruco.generateImageMarker(marker_dict, marker_id, aruco_size)
aruco_bgr = cv2.cvtColor(aruco, cv2.COLOR_GRAY2BGR)
center_x = (target_size - aruco_size) // 2
center_y = (target_size - aruco_size) // 2
quiet = 28
cv2.rectangle(
    target,
    (center_x - quiet, center_y - quiet),
    (center_x + aruco_size + quiet, center_y + aruco_size + quiet),
    (255, 255, 255),
    -1,
)
target[center_y:center_y + aruco_size, center_x:center_x + aruco_size] = aruco_bgr

mind_png_path = out_dir / "4x4_1000-0-mind-target.png"
cv2.imwrite(str(mind_png_path), target)
print(f"Generated: {mind_png_path}")
