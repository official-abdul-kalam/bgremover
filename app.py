import os
import io
import uuid
import zipfile
import threading
import time
from typing import Dict, Any, List, Optional, Tuple

from flask import Flask, request, jsonify, send_file, send_from_directory
from PIL import Image

# Image processing utilities
from processing import ImageProcessor, ProcessingOptions

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
OUTPUT_DIR = os.path.join(DATA_DIR, "outputs")
MODEL_DIR = os.path.join(BASE_DIR, "models")
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(MODEL_DIR, exist_ok=True)

# Ensure rembg models are discovered offline if placed under models/
os.environ.setdefault("U2NET_HOME", MODEL_DIR)

app = Flask(__name__, static_folder=STATIC_DIR, template_folder=TEMPLATE_DIR)

# Global in-memory job store (simple, single-process)
JOBS: Dict[str, Dict[str, Any]] = {}
# Cache for background removal results per file and model/options
BG_CACHE: Dict[str, Tuple[Image.Image, Image.Image]] = {}

# Initialize processor
processor = ImageProcessor(model_dir=MODEL_DIR)


def _save_image_bytes(image: Image.Image, path: str, fmt: str, quality: int = 95) -> None:
    fmt_u = fmt.upper()
    save_kwargs: Dict[str, Any] = {}
    if fmt_u == "JPG":
        fmt_u = "JPEG"
    if fmt_u in ("JPEG", "JPG"):
        save_kwargs.update({"quality": quality, "optimize": True})
        # Ensure no alpha for JPEG
        if image.mode in ("RGBA", "LA"):
            bg = Image.new("RGB", image.size, (255, 255, 255))
            bg.paste(image, mask=image.split()[-1])
            image_to_save = bg
        else:
            image_to_save = image.convert("RGB")
    else:
        image_to_save = image
    image_to_save.save(path, fmt_u, **save_kwargs)


def _cache_key(file_id: str, opts: ProcessingOptions) -> str:
    return (
        f"{file_id}:{opts.rembg_model}:{int(opts.alpha_matting)}:"
        f"{opts.alpha_matting_erode_size}:{opts.alpha_matting_foreground_threshold}:{opts.alpha_matting_background_threshold}"
    )


def _get_removed_bg(file_id: str, opts: ProcessingOptions) -> Tuple[Image.Image, Image.Image]:
    key = _cache_key(file_id, opts)
    if key in BG_CACHE:
        return BG_CACHE[key]
    in_path = os.path.join(UPLOAD_DIR, f"{file_id}.png")
    image = Image.open(in_path).convert("RGBA")
    rgba, mask = processor.remove_background(image, opts)
    BG_CACHE[key] = (rgba, mask)
    return rgba, mask


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/static/<path:path>")
def static_proxy(path):
    return send_from_directory(STATIC_DIR, path)


@app.route("/api/upload", methods=["POST"]) 
def api_upload():
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "No files uploaded"}), 400

    file_ids: List[str] = []
    for f in files:
        try:
            image = Image.open(f.stream).convert("RGBA")
        except Exception:
            return jsonify({"error": f"Invalid image file: {f.filename}"}), 400
        fid = str(uuid.uuid4())
        save_path = os.path.join(UPLOAD_DIR, f"{fid}.png")
        image.save(save_path)
        file_ids.append(fid)

    # Generate initial preview for first file
    first_id = file_ids[0]
    # Use default rembg options (isnet-general-use, alpha-matting)
    default_opts = ProcessingOptions()
    rgba, mask = _get_removed_bg(first_id, default_opts)

    # Default preview options for effects
    options = ProcessingOptions()
    preview_image = processor.apply_all(rgba, mask, options)

    b64 = processor.image_to_base64(preview_image, format="PNG")
    mask_b64 = processor.image_to_base64(mask, format="PNG")

    return jsonify({
        "fileIds": file_ids,
        "preview": b64,
        "mask": mask_b64
    })


@app.route("/api/preview", methods=["POST"]) 
def api_preview():
    data = request.get_json(force=True)
    file_id: str = data.get("fileId")
    if not file_id:
        return jsonify({"error": "fileId is required"}), 400

    path = os.path.join(UPLOAD_DIR, f"{file_id}.png")
    if not os.path.exists(path):
        return jsonify({"error": "File not found"}), 404

    try:
        options = ProcessingOptions.from_dict(data.get("options", {}))
    except Exception as e:
        return jsonify({"error": f"Invalid options: {e}"}), 400

    # Speed preview: reuse cached removal and optionally downscale for UI
    rgba, mask = _get_removed_bg(file_id, options)

    fast = bool(data.get("fast", True))
    if fast:
        max_side = 1024
        w, h = rgba.size
        scale = min(1.0, max_side / max(w, h))
        if scale < 1.0:
            new_size = (int(w * scale), int(h * scale))
            rgba = rgba.resize(new_size, Image.LANCZOS)
            mask = mask.resize(new_size, Image.LANCZOS)

    result = processor.apply_all(rgba, mask, options)

    fmt = "PNG" if options.output_format.upper() == "PNG" else "JPEG"
    b64 = processor.image_to_base64(result, fmt)
    return jsonify({"preview": b64})


@app.route("/api/process", methods=["POST"]) 
def api_process():
    data = request.get_json(force=True)
    file_ids: List[str] = data.get("fileIds", [])
    if not file_ids:
        return jsonify({"error": "fileIds is required"}), 400

    try:
        options = ProcessingOptions.from_dict(data.get("options", {}))
    except Exception as e:
        return jsonify({"error": f"Invalid options: {e}"}), 400

    job_id = str(uuid.uuid4())
    JOBS[job_id] = {
        "status": "queued",
        "progress": 0,
        "total": len(file_ids),
        "done": 0,
        "files": [],
        "error": None,
        "zip_path": None
    }

    def _worker():
        try:
            JOBS[job_id]["status"] = "running"
            result_files: List[str] = []
            for idx, fid in enumerate(file_ids, start=1):
                rgba, mask = _get_removed_bg(fid, options)
                out_img = processor.apply_all(rgba, mask, options)
                # Upscale if requested
                if options.upscale > 1.0:
                    out_img = processor.upscale_image(out_img, scale=options.upscale)
                # Save
                out_fmt = options.output_format.upper()
                if out_fmt == "JPG":
                    out_fmt = "JPEG"
                out_name = f"{fid}.{out_fmt.lower()}"
                out_path = os.path.join(OUTPUT_DIR, out_name)
                _save_image_bytes(out_img, out_path, fmt=out_fmt, quality=options.jpg_quality)
                # Mask-only export if requested
                if options.export_mask:
                    mask_name = f"{fid}_mask.png"
                    mask_path = os.path.join(OUTPUT_DIR, mask_name)
                    mask.save(mask_path, "PNG")
                    result_files.append(mask_name)
                result_files.append(out_name)
                JOBS[job_id]["done"] = idx
                JOBS[job_id]["progress"] = int(idx * 100 / len(file_ids))
                time.sleep(0.005)

            # Zip results
            zip_name = f"job_{job_id}.zip"
            zip_path = os.path.join(OUTPUT_DIR, zip_name)
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                for name in result_files:
                    zf.write(os.path.join(OUTPUT_DIR, name), arcname=name)
            JOBS[job_id]["zip_path"] = zip_name
            JOBS[job_id]["files"] = result_files
            JOBS[job_id]["status"] = "finished"
            JOBS[job_id]["progress"] = 100
        except Exception as e:
            JOBS[job_id]["status"] = "error"
            JOBS[job_id]["error"] = str(e)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()

    return jsonify({"jobId": job_id})


@app.route("/api/job_status/<job_id>")
def api_job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify({
        "status": job["status"],
        "progress": job["progress"],
        "done": job["done"],
        "total": job["total"],
        "error": job["error"],
        "zip": job["zip_path"],
        "files": job["files"],
    })


@app.route("/download/<path:filename>")
def download_file(filename: str):
    return send_from_directory(OUTPUT_DIR, filename, as_attachment=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    app.run(host="0.0.0.0", port=port, debug=True)