"""
Render one maquette shot headless.

  python render_shot.py --shot shots/hook.py --out out/hook/ [--res 720x900] [--samples 24] [--range 1-48]
                        [--still 12[,30,...]] [--usd out/hook.usdc] [--fonts /path/to/fonts]

A shot is a .py file with build(m) (m = the maquette module), or an OpenUSD stage (.usd/.usda/.usdc) with a camera.
Writes PNG frames out/0001.png ... (RGBA when the shot is transparent) and prints one JSON line:
{"frames": n, "fps": 24, "transparent": bool, "width": w, "height": h}
"""
import argparse
import importlib.util
import json
import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # keep the plugin folder unchanged (its trust hash covers every file)
sys.path.insert(0, HERE)
import maquette  # noqa: E402


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    ap = argparse.ArgumentParser()
    ap.add_argument('--shot', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--res', default=None)
    ap.add_argument('--samples', type=int, default=None)
    ap.add_argument('--range', default=None)
    ap.add_argument('--still', default=None, help='a frame or a comma list of frames')
    ap.add_argument('--usd', default=None)
    ap.add_argument('--fonts', default=None)
    a = ap.parse_args(argv)
    maquette.FONT_DIR = a.fonts

    shot = os.path.abspath(a.shot)
    ext = os.path.splitext(shot)[1].lower()
    maquette.reset()
    if ext == '.py':
        spec = importlib.util.spec_from_file_location('shot', shot)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.build(maquette)
    elif ext in ('.usd', '.usda', '.usdc', '.usdz'):
        bpy.ops.wm.usd_import(filepath=shot, import_cameras=True, import_lights=True, import_materials=True, set_frame_range=True)
        sc = bpy.context.scene
        cams = [o for o in sc.objects if o.type == 'CAMERA']
        if not cams:
            print(json.dumps({'error': 'the USD stage has no camera'}))
            sys.exit(1)
        sc.camera = cams[0]
        if sc.render.engine != 'CYCLES':
            maquette.scene_setup(sc.frame_end, (sc.render.resolution_x, sc.render.resolution_y))
    else:
        print(json.dumps({'error': f'unknown shot type {ext}'}))
        sys.exit(1)

    sc = bpy.context.scene
    if a.res:
        w, h = (int(v) for v in a.res.lower().split('x'))
        sc.render.resolution_x, sc.render.resolution_y = w, h
    if a.samples:
        sc.cycles.samples = a.samples
    if a.usd:
        maquette.save_usd(os.path.abspath(a.usd))

    os.makedirs(a.out, exist_ok=True)
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA' if sc.render.film_transparent else 'RGB'
    sc.render.image_settings.color_depth = '8'
    t0 = time.time()
    if a.still is not None:
        stills = [int(v) for v in str(a.still).split(',') if v]
        for f in stills:
            sc.frame_set(f)
            sc.render.filepath = os.path.join(os.path.abspath(a.out), f'still_{f:04d}.png')
            bpy.ops.render.render(write_still=True)
        n = len(stills)
    else:
        if a.range:
            s, e = (int(v) for v in a.range.split('-'))
            sc.frame_start, sc.frame_end = s, e
        sc.render.filepath = os.path.join(os.path.abspath(a.out), '')
        bpy.ops.render.render(animation=True)
        n = sc.frame_end - sc.frame_start + 1
    print(json.dumps({'frames': n, 'fps': sc.render.fps, 'transparent': bool(sc.render.film_transparent),
                      'width': sc.render.resolution_x, 'height': sc.render.resolution_y, 'seconds': round(time.time() - t0, 1)}))


main()
