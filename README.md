# Premium Background Remover & Image Enhancer (Offline)

Modern, offline image background remover and enhancer with a premium glassmorphism UI.

## Features
- Background removal using rembg (U^2-Net)
- Transparent PNG, solid color, or image background replacement
- Effects: background blur, shadow, glow, and AR-style (neon, holo, bokeh)
- Optional upscaling using Real-ESRGAN (CPU/GPU)
- Mask-only export option
- Batch processing with progress
- Drag-and-drop web UI with before/after slider, dark/light theme
- Works offline (bundle models locally)

## Project Structure
```
app.py               # Flask backend
processing.py        # Image processing pipeline
static/              # Front-end (HTML/CSS/JS)
  index.html
  css/style.css
  js/app.js
models/              # Place rembg models here for full offline
data/uploads         # Uploaded images (runtime)
data/outputs         # Results (runtime)
```

## Setup
1. Create and activate a virtual environment
```
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
```
2. Install dependencies
```
pip install -r requirements.txt
```

### Offline model setup (rembg)
- Download the U^2-Net ONNX models ahead of time and place them under `models/`.
- The app sets `U2NET_HOME` to `models/` automatically.
- You can prefetch models by running once with internet, or manually place files. See rembg docs for supported model names.

### Optional: Real-ESRGAN weights
- If using the `realesrgan` Python package, it can auto-download weights on first use.
- For fully offline usage, place `RealESRGAN_x4.pth` under `weights/` and ensure `realesrgan` can find it. The code attempts to load from `weights/RealESRGAN_x4.pth`.

## Run
```
python app.py
```
Open `http://localhost:7860` in your browser.

## Usage Tips
- Drag and drop multiple images. The first shows in the preview.
- Use the Background buttons to toggle transparent/color/image. For color, pick a color. For image, click "Choose Image" and select a background image.
- Effects update the preview in near real-time.
- Click "Save Current" to export only the current image, or "Process Batch" to export all at once.
- Choose output format (PNG or JPG). Mask-only export adds a separate `_mask.png` per image.
- Upscaling uses Real-ESRGAN when available (else falls back to high-quality Lanczos).

## Packaging (Standalone)

### Windows .exe (PyInstaller)
```
pyinstaller --noconfirm --onefile --add-data "static:static" --add-data "models:models" --add-data "processing.py:." app.py
```
Run the generated executable from `dist/app`.

### Linux .deb
1. Build the binary with PyInstaller as above (onefile).
2. Create a folder structure for the package:
```
mkdir -p build-deb/opt/bg-remover
cp dist/app build-deb/opt/bg-remover/bg-remover
mkdir -p build-deb/usr/share/applications
cat > build-deb/usr/share/applications/bg-remover.desktop <<EOF
[Desktop Entry]
Type=Application
Name=BG Remover Pro
Exec=/opt/bg-remover/bg-remover
Icon=utilities-terminal
Categories=Graphics;
EOF
mkdir -p build-deb/DEBIAN
cat > build-deb/DEBIAN/control <<EOF
Package: bg-remover-pro
Version: 1.0.0
Section: utils
Priority: optional
Architecture: amd64
Maintainer: You <you@example.com>
Description: Offline premium background remover and enhancer
EOF
```
3. Build the package:
```
dpkg-deb --build build-deb
```
Install with `sudo dpkg -i build-deb.deb`.

## Electron Desktop App
This project can run as a desktop app using Electron. The Electron shell starts the Python backend and loads the UI.

### Setup
```
cd electron
npm install
```

### Run
```
npm start
```

### Build
```
npm run build
```

Electron uses the backend at `http://127.0.0.1:7860` by launching `python app.py`. Adjust the command in `electron/main.js` if you need a different Python path. For packaged binaries, point to your PyInstaller onefile binary instead of `python app.py`.

### Rembg settings
- Default model: `isnet-general-use`
- Alpha matting enabled with erode size 15, tuned thresholds
- You can change these in the UI later or via `ProcessingOptions`.

## Notes
- First run of rembg or realesrgan may attempt to download models. For fully offline, ensure models are present in `models/` and `weights/` folders before running.
- To reduce footprint, comment out `realesrgan` and `torch` in `requirements.txt` if you do not need upscaling.
- This app avoids external CDNs; all assets are served locally.