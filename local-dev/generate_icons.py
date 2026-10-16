import os
from PIL import Image, ImageDraw, ImageFont

script_dir = os.path.dirname(os.path.abspath(__file__))
font_path = os.path.join(script_dir, 'Outfit-Bold.ttf')
if not os.path.exists(font_path):
    font_path = 'Outfit-Bold.ttf'

def create_icon(size, radius, font_size_ratio=0.48):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    bg_color = '#feb414'
    text_color = '#000000'
    
    # Draw rounded rectangle
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=bg_color)
    
    font_size = int(size * font_size_ratio)
    font = ImageFont.truetype(font_path, font_size)
    bbox = draw.textbbox((0, 0), 'g86', font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (size - text_w) / 2 - bbox[0]
    y = (size - text_h) / 2 - bbox[1]
    
    draw.text((x, y), 'g86', fill=text_color, font=font)
    return img

def create_adaptive_foreground(size=432):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    box_size = 288
    box_offset = (size - box_size) // 2
    box_radius = int(box_size * 0.125)
    
    draw.rounded_rectangle(
        [box_offset, box_offset, box_offset + box_size - 1, box_offset + box_size - 1],
        radius=box_radius,
        fill='#feb414'
    )
    
    font_size = int(box_size * 0.48)
    font = ImageFont.truetype(font_path, font_size)
    bbox = draw.textbbox((0, 0), 'g86', font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (size - text_w) / 2 - bbox[0]
    y = (size - text_h) / 2 - bbox[1]
    
    draw.text((x, y), 'g86', fill='#000000', font=font)
    return img

densities = {
    'mipmap-mdpi': (48, 6),
    'mipmap-hdpi': (72, 9),
    'mipmap-xhdpi': (96, 12),
    'mipmap-xxhdpi': (144, 18),
    'mipmap-xxxhdpi': (192, 24)
}

res_dir = 'android-app/app/src/main/res'
for density, (size, radius) in densities.items():
    d_path = os.path.join(res_dir, density)
    os.makedirs(d_path, exist_ok=True)
    icon = create_icon(size, radius)
    icon.save(os.path.join(d_path, 'ic_launcher.png'))
    icon.save(os.path.join(d_path, 'ic_launcher_round.png'))
    print(f'Created {density} ic_launcher ({size}x{size})')

create_icon(192, 24).save(os.path.join(res_dir, 'drawable', 'ic_node.png'))
print('Created drawable/ic_node.png')

adaptive_fg = create_adaptive_foreground(432)
adaptive_fg.save(os.path.join(res_dir, 'drawable', 'ic_launcher_foreground.png'))
print('Created drawable/ic_launcher_foreground.png')

web_dirs = ['web', 'android-app/app/src/main/assets/public']
svg_content = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" rx="6" ry="6" fill="#feb414"/>
  <text x="50" y="54" font-family="'Outfit', sans-serif" font-weight="700" font-size="46" fill="#000000" text-anchor="middle" dominant-baseline="central">g86</text>
</svg>"""

for w_dir in web_dirs:
    os.makedirs(w_dir, exist_ok=True)
    create_icon(192, 24).save(os.path.join(w_dir, 'icon-192.png'))
    create_icon(512, 64).save(os.path.join(w_dir, 'icon-512.png'))
    with open(os.path.join(w_dir, 'icon.svg'), 'w', encoding='utf-8') as f:
        f.write(svg_content)
    print(f'Updated web icons in {w_dir}')
