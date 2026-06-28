from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
os.makedirs(OUT_DIR, exist_ok=True)

ACCENT = (99, 102, 241)
BG = (12, 13, 16)

def make_icon(size, filename, rounded=True):
    img = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(img)

    pad = int(size * 0.12)
    box = [pad, pad, size - pad, size - pad]
    radius = int(size * 0.22) if rounded else 0
    draw.rounded_rectangle(box, radius=radius, fill=ACCENT)

    text = "C"
    font_size = int(size * 0.42)
    try:
        font = ImageFont.truetype("segoeuib.ttf", font_size)
    except Exception:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1]), text, fill="white", font=font)

    img.save(os.path.join(OUT_DIR, filename))
    print("wrote", filename)

for size in [180, 192, 512]:
    make_icon(size, f"icon-{size}.png")
