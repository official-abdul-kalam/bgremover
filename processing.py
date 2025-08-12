import base64
import io
import os
from dataclasses import dataclass
from typing import Optional, Tuple, Dict, Any

import numpy as np
from PIL import Image, ImageFilter, ImageOps

try:
    from rembg import remove
    from rembg.session_factory import new_session
except Exception as e:
    remove = None
    new_session = None

try:
    import cv2
except Exception:
    cv2 = None

# Optional Real-ESRGAN
try:
    from realesrgan import RealESRGAN
    import torch
except Exception:
    RealESRGAN = None
    torch = None


@dataclass
class ProcessingOptions:
    background_mode: str = "transparent"  # transparent | color | image
    background_color: str = "#00000000"  # RGBA hex
    background_image_id: Optional[str] = None

    blur_background: float = 0.0  # 0..50 (px)
    add_shadow: bool = False
    shadow_offset_x: int = 20
    shadow_offset_y: int = 20
    shadow_blur: int = 40
    shadow_opacity: float = 0.5

    add_glow: bool = False
    glow_radius: int = 20
    glow_intensity: float = 0.6
    glow_color: str = "#00FFFF"  # neon cyan

    ar_style: str = "none"  # none | neon | holo | bokeh

    upscale: float = 1.0  # 1.0, 2.0, 4.0
    output_format: str = "PNG"  # PNG | JPG
    output_width: Optional[int] = None
    output_height: Optional[int] = None
    jpg_quality: int = 95
    export_mask: bool = False

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "ProcessingOptions":
        opts = ProcessingOptions()
        for k, v in d.items():
            if hasattr(opts, k):
                setattr(opts, k, v)
        return opts


class ImageProcessor:
    def __init__(self, model_dir: Optional[str] = None):
        self.model_dir = model_dir
        self._rembg_session = None
        if new_session is not None:
            try:
                self._rembg_session = new_session("u2net")
            except Exception:
                self._rembg_session = None
        self._realesrgan_model = None

    def image_to_base64(self, image: Image.Image, format: str = "PNG") -> str:
        buf = io.BytesIO()
        image.save(buf, format=format)
        buf.seek(0)
        return "data:image/" + format.lower() + ";base64," + base64.b64encode(buf.getvalue()).decode("utf-8")

    def _hex_to_rgba(self, hex_color: str) -> Tuple[int, int, int, int]:
        hex_color = hex_color.lstrip("#")
        if len(hex_color) == 8:
            r = int(hex_color[0:2], 16)
            g = int(hex_color[2:4], 16)
            b = int(hex_color[4:6], 16)
            a = int(hex_color[6:8], 16)
            return (r, g, b, a)
        if len(hex_color) == 6:
            r = int(hex_color[0:2], 16)
            g = int(hex_color[2:4], 16)
            b = int(hex_color[4:6], 16)
            return (r, g, b, 255)
        raise ValueError("Invalid color hex")

    def remove_background(self, image: Image.Image) -> Tuple[Image.Image, Image.Image]:
        if remove is None:
            raise RuntimeError("rembg is not installed")
        session = self._rembg_session
        out = remove(image, session=session)
        rgba = out.convert("RGBA")
        # mask is alpha channel
        alpha = rgba.split()[-1]
        mask = Image.merge("LA", (alpha, alpha))
        mask = mask.convert("RGBA")
        return rgba, alpha

    def _resize_if_needed(self, image: Image.Image, opts: ProcessingOptions) -> Image.Image:
        if opts.output_width and opts.output_height:
            return image.resize((opts.output_width, opts.output_height), Image.LANCZOS)
        return image

    def _apply_background(self, rgba: Image.Image, mask: Image.Image, opts: ProcessingOptions) -> Image.Image:
        w, h = rgba.size
        if opts.background_mode == "transparent":
            return rgba
        if opts.background_mode == "color":
            r, g, b, a = self._hex_to_rgba(opts.background_color)
            bg = Image.new("RGBA", (w, h), (r, g, b, a))
            bg.paste(rgba, mask=mask)
            return bg
        if opts.background_mode == "image" and opts.background_image_id:
            # Expect background image stored in data/uploads as PNG
            bg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "uploads", f"{opts.background_image_id}.png")
            if os.path.exists(bg_path):
                bg_img = Image.open(bg_path).convert("RGBA").resize((w, h), Image.LANCZOS)
                bg_img.paste(rgba, mask=mask)
                return bg_img
        return rgba

    def _apply_blur_background(self, image: Image.Image, mask: Image.Image, radius: float) -> Image.Image:
        if radius <= 0:
            return image
        blur_bg = image.filter(ImageFilter.GaussianBlur(radius=radius))
        # Keep subject sharp using mask
        sharp_subject = Image.new("RGBA", image.size, (0, 0, 0, 0))
        sharp_subject.paste(image, mask=mask)
        # Composite: blurred base + sharp subject on top
        base = blur_bg.copy()
        base.paste(sharp_subject, mask=sharp_subject.split()[-1])
        return base

    def _add_shadow(self, image: Image.Image, mask: Image.Image, opts: ProcessingOptions) -> Image.Image:
        if not opts.add_shadow:
            return image
        w, h = image.size
        # Create shadow from mask
        alpha = mask
        shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        shadow_mask = Image.new("L", (w, h), 0)
        shadow_mask.paste(alpha, (max(0, opts.shadow_offset_x), max(0, opts.shadow_offset_y)))
        shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(radius=opts.shadow_blur))
        s = Image.new("RGBA", (w, h), (0, 0, 0, int(255 * opts.shadow_opacity)))
        shadow.paste(s, mask=shadow_mask)
        out = shadow.copy()
        out.paste(image, mask=image.split()[-1])
        return out

    def _add_glow(self, image: Image.Image, mask: Image.Image, opts: ProcessingOptions) -> Image.Image:
        if not opts.add_glow:
            return image
        w, h = image.size
        # Outline from mask
        edge = ImageOps.expand(Image.new("L", (w, h), 0))
        edge = mask.copy().filter(ImageFilter.FIND_EDGES)
        edge = edge.filter(ImageFilter.GaussianBlur(radius=max(1, opts.glow_radius // 2)))
        r, g, b, _ = self._hex_to_rgba(opts.glow_color)
        glow_layer = Image.new("RGBA", (w, h), (r, g, b, 0))
        glow_layer.putalpha(edge)
        # Intensify
        alpha = glow_layer.split()[-1].point(lambda a: min(255, int(a * opts.glow_intensity * 2)))
        glow_layer.putalpha(alpha)
        out = image.copy()
        out = Image.alpha_composite(out, glow_layer)
        return out

    def _apply_ar_style(self, image: Image.Image, mask: Image.Image, style: str) -> Image.Image:
        if style == "none":
            return image
        if style == "neon":
            # Neon edge + slight bloom
            edge = mask.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(6))
            neon = Image.new("RGBA", image.size, (255, 0, 128, 0))
            neon.putalpha(edge)
            return Image.alpha_composite(image, neon)
        if style == "holo":
            # Holographic gradient overlay clipped to subject
            w, h = image.size
            gradient = Image.new("RGBA", (w, h))
            grad = np.zeros((h, w, 4), dtype=np.uint8)
            for y in range(h):
                t = y / max(1, h - 1)
                r = int(255 * (0.6 + 0.4 * t))
                g = int(255 * (0.3 + 0.7 * (1 - t)))
                b = int(255 * (0.8 * (1 - t) + 0.2 * t))
                a = int(140)
                grad[y, :, :] = [r, g, b, a]
            gradient = Image.fromarray(grad, mode="RGBA")
            subject = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            subject.paste(gradient, mask=mask)
            return Image.alpha_composite(image, subject)
        if style == "bokeh":
            # Background bokeh blur
            return self._apply_blur_background(image, mask, radius=18)
        return image

    def apply_all(self, rgba: Image.Image, mask: Image.Image, opts: ProcessingOptions) -> Image.Image:
        img = self._apply_background(rgba, mask, opts)
        img = self._apply_blur_background(img, mask, opts.blur_background)
        img = self._add_shadow(img, mask, opts)
        img = self._add_glow(img, mask, opts)
        img = self._apply_ar_style(img, mask, opts.ar_style)
        img = self._resize_if_needed(img, opts)
        return img

    def _init_realesrgan(self, device: str = "cpu"):
        if self._realesrgan_model is not None:
            return
        if RealESRGAN is None:
            return
        try:
            # Use default 4x model
            self._realesrgan_model = RealESRGAN(device=device, scale=4)
            self._realesrgan_model.load_weights("weights/RealESRGAN_x4.pth", download=True)
        except Exception:
            self._realesrgan_model = None

    def upscale_image(self, image: Image.Image, scale: float = 2.0) -> Image.Image:
        if scale <= 1.01:
            return image
        # Try Real-ESRGAN
        if RealESRGAN is not None:
            try:
                device = "cuda" if (torch is not None and torch.cuda.is_available()) else "cpu"
                self._init_realesrgan(device=device)
                if self._realesrgan_model is not None:
                    img_cv = cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2BGR)
                    out = self._realesrgan_model.predict(img_cv)
                    out = cv2.cvtColor(out, cv2.COLOR_BGR2RGB)
                    pil = Image.fromarray(out)
                    if scale not in (2.0, 4.0):
                        new_w = int(pil.width * scale)
                        new_h = int(pil.height * scale)
                        pil = pil.resize((new_w, new_h), Image.LANCZOS)
                    return pil
            except Exception:
                pass
        # Fallback: Lanczos upscale
        new_w = int(image.width * scale)
        new_h = int(image.height * scale)
        return image.resize((new_w, new_h), Image.LANCZOS)