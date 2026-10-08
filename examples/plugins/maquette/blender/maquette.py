"""
maquette: a small kit for animated 3D shots rendered headless with Blender (bpy), for Michelangelo.

A shot is a Python file with `build(m)` (m is this module) that sets up the scene and returns nothing.
render_shot.py loads it, renders a PNG sequence and (optionally) exports the stage to OpenUSD.

Everything here is procedural: no downloaded models, so shots are reproducible and licence-clean.
"""
import math
import bmesh
import bpy
from mathutils import Vector

FPS = 24
FONT_DIR = None  # set by render_shot.py (Michelangelo's bundled fonts)

# ---------------------------------------------------------------- scene


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    prefs = bpy.context.preferences.edit
    prefs.keyframe_new_interpolation_type = 'BEZIER'
    prefs.keyframe_new_handle_type = 'AUTO_CLAMPED'


def scene_setup(frames, res=(720, 900), transparent=False, world=(0.62, 0.58, 0.72), world_strength=0.6):
    sc = bpy.context.scene
    sc.render.fps = FPS
    sc.frame_start, sc.frame_end = 1, frames
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = transparent
    sc.render.engine = 'CYCLES'
    sc.render.use_motion_blur = True
    sc.render.motion_blur_shutter = 0.45
    sc.render.use_persistent_data = True
    c = sc.cycles
    c.device = 'CPU'
    c.samples = 10
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.04
    c.use_denoising = True
    c.max_bounces = 4
    c.diffuse_bounces = 2
    c.glossy_bounces = 2
    c.transmission_bounces = 2
    c.transparent_max_bounces = 4
    c.caustics_reflective = False
    c.caustics_refractive = False
    c.blur_glossy = 1.0
    try:
        sc.view_settings.view_transform = 'Khronos PBR Neutral'
        sc.view_settings.look = 'None'
        sc.view_settings.exposure = -0.3
    except TypeError:
        pass
    w = bpy.data.worlds.new('world')
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs[0].default_value = (*world, 1)
    bg.inputs[1].default_value = world_strength
    sc.world = w
    return sc


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def empty(name, loc=(0, 0, 0), parent=None):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_size = 0.2
    ob.location = loc
    link(ob)
    if parent:
        ob.parent = parent
    return ob


def camera(loc, target, lens=50, dof=None, fstop=2.8):
    cam = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
    link(cam)
    cam.location = loc
    cam.data.lens = lens
    aim(cam, target)
    if dof is not None:
        cam.data.dof.use_dof = True
        cam.data.dof.focus_distance = dof
        cam.data.dof.aperture_fstop = fstop
    bpy.context.scene.camera = cam
    return cam


def aim(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def area_light(name, loc, target, energy, size, color=(1, 1, 1)):
    l = bpy.data.objects.new(name, bpy.data.lights.new(name, 'AREA'))
    l.data.energy = energy
    l.data.size = size
    l.data.color = color
    l.location = loc
    link(l)
    aim(l, target)
    return l


def studio_lights(key=1.0, warm=(1.0, 0.86, 0.72), rim=(0.65, 0.85, 1.0), target=(0, 0, 1.3)):
    area_light('Key', (-3.2, -4.0, 4.4), target, 900 * key, 4.0, warm)
    area_light('Fill', (4.0, -3.0, 1.8), target, 220 * key, 5.0, (0.85, 0.9, 1.0))
    area_light('Rim', (2.2, 3.5, 3.8), target, 900 * key, 2.5, rim)


def backdrop(color, rough=0.9, name='Backdrop'):
    """A seamless studio sweep: floor curving up into a wall behind."""
    prof = []
    for i in range(12):
        prof.append((-12 + i * 1.2, 0.0))
    r = 3.0
    for i in range(1, 13):
        a = (i / 12) * (math.pi / 2)
        prof.append((1.2 + math.sin(a) * r, r - math.cos(a) * r))
    prof.append((1.2 + r, 18.0))
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rows = []
    for x in (-25.0, 25.0):
        rows.append([bm.verts.new((x, y, z)) for y, z in prof])
    for i in range(len(prof) - 1):
        bm.faces.new((rows[0][i], rows[1][i], rows[1][i + 1], rows[0][i + 1]))
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    for p in me.polygons:
        p.use_smooth = True
    ob.data.materials.append(mat(name + 'Mat', color, rough=rough))
    ob.location = (0, 2.0, 0)
    return ob


# ---------------------------------------------------------------- materials


def mat(name, color, rough=0.4, metal=0.0, coat=0.0, sheen=0.0, sss=0.0, emit=None, strength=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    b.inputs['Coat Weight'].default_value = coat
    b.inputs['Coat Roughness'].default_value = 0.08
    b.inputs['Sheen Weight'].default_value = sheen
    if sss:
        b.inputs['Subsurface Weight'].default_value = sss
        b.inputs['Subsurface Radius'].default_value = (0.4, 0.25, 0.2)
        b.inputs['Subsurface Scale'].default_value = 0.08
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = strength
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
    return m


def assign(ob, m):
    ob.data.materials.clear()
    ob.data.materials.append(m)
    return ob


# ---------------------------------------------------------------- primitives


def _finish(ob, name, parent, smooth=True):
    ob.name = name
    if parent:
        ob.parent = parent
        ob.matrix_parent_inverse.identity()
    if smooth and ob.type == 'MESH':
        for p in ob.data.polygons:
            p.use_smooth = True
    return ob


def sphere(name, loc, scale, m, parent=None, seg=48):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=seg // 2, radius=1, location=(0, 0, 0))
    ob = bpy.context.active_object
    ob.scale = scale
    _finish(ob, name, parent)
    ob.location = loc
    return assign(ob, m)


def rbox(name, loc, size, bevel, m, parent=None, segs=6):
    """A rounded box (bevelled cube, smooth)."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    ob = bpy.context.active_object
    ob.scale = size
    bpy.ops.object.transform_apply(scale=True)
    bv = ob.modifiers.new('bevel', 'BEVEL')
    bv.width = bevel
    bv.segments = segs
    bv.limit_method = 'NONE'
    bv.harden_normals = False
    _finish(ob, name, parent)
    ob.location = loc
    sub = ob.modifiers.new('sub', 'SUBSURF')
    sub.levels = sub.render_levels = 1
    return assign(ob, m)


def cylinder(name, loc, radius, depth, m, parent=None, rot=(0, 0, 0), verts=32):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=(0, 0, 0))
    ob = bpy.context.active_object
    bv = ob.modifiers.new('bevel', 'BEVEL')
    bv.width = min(radius, depth) * 0.3
    bv.segments = 3
    _finish(ob, name, parent)
    ob.location = loc
    ob.rotation_euler = rot
    return assign(ob, m)


def smile(name, loc, width, m, parent=None, thick=0.022, curve=0.55):
    """An emissive smile: the lower part of a torus."""
    bpy.ops.mesh.primitive_torus_add(major_radius=width, minor_radius=thick, major_segments=64, minor_segments=12, location=(0, 0, 0), rotation=(math.pi / 2, 0, 0))
    ob = bpy.context.active_object
    bpy.ops.object.transform_apply(rotation=True)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    kill = [v for v in bm.verts if v.co.z > -width * curve]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    bm.to_mesh(ob.data)
    bm.free()
    _finish(ob, name, parent)
    ob.location = loc
    return assign(ob, m)


def text(name, body, loc, size, m, parent=None, font='Montserrat-Black.ttf', extrude=0.04, rot=(math.pi / 2, 0, 0), align='CENTER'):
    cu = bpy.data.curves.new(name, 'FONT')
    cu.body = body
    cu.size = size
    cu.extrude = extrude
    cu.bevel_depth = extrude * 0.35
    cu.align_x = align
    cu.align_y = 'CENTER'
    if FONT_DIR:
        try:
            cu.font = bpy.data.fonts.load(f'{FONT_DIR}/{font}', check_existing=True)
        except RuntimeError:
            pass
    ob = link(bpy.data.objects.new(name, cu))
    ob.data.materials.append(m)
    if parent:
        ob.parent = parent
    ob.location = loc
    ob.rotation_euler = rot
    return ob


# ---------------------------------------------------------------- animation


EASE = {'linear': 'LINEAR', 'const': 'CONSTANT'}


def key(ob, path, frame, value, interp=None, index=-1):
    """Set ob.<path> = value and keyframe it at frame. interp: None (smooth bezier), 'linear', 'const', 'back', 'bounce', 'elastic'."""
    tgt = ob
    if path.startswith('data.'):
        tgt, path = ob.data, path[5:]
    if isinstance(value, (tuple, list)):
        setattr(tgt, path, value)
    elif index >= 0:
        getattr(tgt, path)[index] = value
    else:
        setattr(tgt, path, value)
    tgt.keyframe_insert(data_path=path, frame=frame, index=index)
    if interp:
        for fc in _fcurves(tgt):
            if fc.data_path != path:
                continue
            for kp in fc.keyframe_points:
                if abs(kp.co.x - frame) < 0.01:
                    if interp in EASE:
                        kp.interpolation = EASE[interp]
                    else:
                        kp.interpolation = interp.upper()
                        kp.easing = 'EASE_OUT'


def _fcurves(idb):
    ad = idb.animation_data
    if not ad or not ad.action:
        return []
    act = ad.action
    out = []
    if hasattr(act, 'layers') and len(act.layers):
        slot = ad.action_slot
        for layer in act.layers:
            for strip in layer.strips:
                cb = strip.channelbag(slot) if slot else None
                if cb:
                    out.extend(cb.fcurves)
    elif hasattr(act, 'fcurves'):
        out.extend(act.fcurves)
    return out


def keys(ob, path, pairs, interp=None):
    for f, v, *rest in pairs:
        key(ob, path, f, v, rest[0] if rest else interp)


def wiggle(ob, path, start, end, amp, period, index, base=0.0, phase=0.0):
    """A gentle sine loop on one channel (idle bob, hover)."""
    f = start
    while f <= end:
        v = base + amp * math.sin((f - start) / period * 2 * math.pi + phase)
        key(ob, path, f, v, index=index)
        f += max(1, int(period / 4))


# ---------------------------------------------------------------- the character: Michelangelo


TEAL = (0.02, 0.42, 0.40)
TEAL_DARK = (0.012, 0.2, 0.22)
CORAL = (0.95, 0.30, 0.20)
AMBER = (1.0, 0.5, 0.06)


class Michelangelo:
    """Michelangelo: the mascot of the Michelangelo video editor, a small hovering robot with a big screen face, amber eyes and a coral beret.

    Controls (all on empties, keyframe them):
      root      position / overall scale (squash & stretch: scale z vs x,y)
      torso     lean (rotation)
      head      tilt / nod / turn (rotation)
      eyeL/eyeR blink (scale z), look (location x/z)
      lids      (use blink)
      armL/armR shoulder rotation (rotation_euler y: up/down sideways; x: forward)
      antenna   lag (rotation)
      beret     lag (rotation)
      mouth     smile (scale), surprise (use mouthO)
    """

    def __init__(self, name='Michelangelo', loc=(0, 0, 0), scale=1.0, beret=True, glow=3.0):
        self.name = name
        m_body = mat(name + 'Body', TEAL, rough=0.32, coat=0.6, sss=0.05)
        m_dark = mat(name + 'Joint', TEAL_DARK, rough=0.4, coat=0.3)
        m_screen = mat(name + 'Screen', (0.012, 0.016, 0.024), rough=0.12, coat=1.0)
        m_eye = mat(name + 'Eye', AMBER, rough=0.3, emit=AMBER, strength=glow)
        m_white = mat(name + 'Glint', (1, 1, 1), emit=(1, 0.97, 0.9), strength=6)
        m_coral = mat(name + 'Coral', CORAL, rough=0.35, emit=CORAL, strength=1.2)
        m_beret = mat(name + 'Beret', (0.62, 0.035, 0.03), rough=0.85, sheen=0.4)
        m_blush = mat(name + 'Blush', (1.0, 0.35, 0.35), emit=(1.0, 0.32, 0.32), strength=0.7)
        m_rim = mat(name + 'Rim', (0.92, 0.92, 0.9), rough=0.25, metal=0.6)
        self.m_eye = m_eye

        self.root = empty(name, loc)
        self.root.scale = (scale, scale, scale)
        self.torso = empty(name + 'Torso', (0, 0, 0.55), self.root)
        # body: an egg
        sphere(name + 'BodyMesh', (0, 0, 0.12), (0.48, 0.44, 0.56), m_body, self.torso)
        sphere(name + 'Belly', (0, -0.36, 0.06), (0.17, 0.06, 0.17), m_rim, self.torso, seg=32)
        sphere(name + 'Heart', (0, -0.42, 0.06), (0.075, 0.03, 0.075), m_coral, self.torso, seg=24)
        # hover glow under the body
        cylinder(name + 'Thruster', (0, 0, -0.45), 0.2, 0.08, m_dark, self.torso)
        cylinder(name + 'ThrusterGlow', (0, 0, -0.5), 0.14, 0.03, m_eye, self.torso)

        # head on a neck pivot
        self.head = empty(name + 'Head', (0, 0, 0.62), self.torso)
        cylinder(name + 'Neck', (0, 0, -0.02), 0.13, 0.16, m_dark, self.head)
        rbox(name + 'HeadMesh', (0, 0, 0.55), (1.34, 1.0, 0.98), 0.32, m_body, self.head)
        rbox(name + 'ScreenMesh', (0, -0.47, 0.55), (1.1, 0.12, 0.76), 0.22, m_screen, self.head)
        cylinder(name + 'EarL', (-0.7, 0, 0.55), 0.17, 0.12, m_dark, self.head, rot=(0, math.pi / 2, 0))
        cylinder(name + 'EarR', (0.7, 0, 0.55), 0.17, 0.12, m_dark, self.head, rot=(0, math.pi / 2, 0))
        cylinder(name + 'EarLGlow', (-0.77, 0, 0.55), 0.08, 0.03, m_coral, self.head, rot=(0, math.pi / 2, 0))
        cylinder(name + 'EarRGlow', (0.77, 0, 0.55), 0.08, 0.03, m_coral, self.head, rot=(0, math.pi / 2, 0))

        # eyes: tall glowing ovals with a glint, on pivots so they can blink (scale z) and look (move)
        self.eyes = []
        for side, x in (('L', -0.24), ('R', 0.24)):
            piv = empty(name + 'Eye' + side, (x, -0.55, 0.62), self.head)
            sphere(name + 'EyeMesh' + side, (0, 0, 0), (0.135, 0.04, 0.19), m_eye, piv, seg=32)
            sphere(name + 'Glint' + side, (0.045, -0.035, 0.07), (0.035, 0.012, 0.035), m_white, piv, seg=16)
            self.eyes.append(piv)
        self.eyeL, self.eyeR = self.eyes
        self.blush = [sphere(name + 'Blush' + s, (x, -0.545, 0.36), (0.09, 0.012, 0.045), m_blush, self.head, seg=24) for s, x in (('L', -0.38), ('R', 0.38))]
        self.mouth = empty(name + 'Mouth', (0, -0.56, 0.38), self.head)
        smile(name + 'MouthMesh', (0, 0, 0.06), 0.11, m_eye, self.mouth)
        self.mouthO = empty(name + 'MouthO', (0, -0.56, 0.35), self.head)
        sphere(name + 'MouthOMesh', (0, 0, 0), (0.06, 0.02, 0.075), m_eye, self.mouthO, seg=24)
        self.mouthO.scale = (0, 0, 0)

        # antenna (lags behind head moves)
        self.antenna = empty(name + 'Antenna', (0.18, 0, 1.02), self.head)
        cylinder(name + 'AntennaStick', (0, 0, 0.14), 0.025, 0.28, m_dark, self.antenna)
        sphere(name + 'AntennaTip', (0, 0, 0.32), (0.075, 0.075, 0.075), m_coral, self.antenna, seg=24)

        # the beret: Michelangelo's signature
        self.beret = empty(name + 'BeretPivot', (-0.12, 0.02, 1.0), self.head)
        if beret:
            sphere(name + 'Beret', (0, 0, 0.04), (0.62, 0.58, 0.15), m_beret, self.beret)
            self.beret.rotation_euler = (0.12, -0.22, 0)

        # arms: shoulder pivots, a capsule and a hand
        self.arms = []
        for side, x in (('L', -1), ('R', 1)):
            piv = empty(name + 'Arm' + side, (x * 0.44, 0, 0.2), self.torso)
            sphere(name + 'Shoulder' + side, (0, 0, 0), (0.1, 0.1, 0.1), m_dark, piv, seg=24)
            sphere(name + 'ArmMesh' + side, (x * 0.05, 0, -0.26), (0.075, 0.075, 0.26), m_body, piv, seg=24)
            hand = empty(name + 'Hand' + side, (x * 0.07, 0, -0.52), piv)
            sphere(name + 'HandMesh' + side, (0, 0, 0), (0.12, 0.11, 0.12), m_dark, hand, seg=24)
            piv.rotation_euler = (0, -x * 0.18, 0)
            self.arms.append(piv)
        self.armL, self.armR = self.arms
        self.handL = bpy.data.objects[name + 'HandL']
        self.handR = bpy.data.objects[name + 'HandR']

    # --- acting helpers (frames are absolute) ---

    def blink(self, f, dur=5):
        for e in self.eyes:
            key(e, 'scale', f - 1, (1, 1, 1))
            key(e, 'scale', f + dur // 2, (1.1, 1, 0.08))
            key(e, 'scale', f + dur, (1, 1, 1))

    def eyes_shape(self, f, sx, sz):
        for e in self.eyes:
            key(e, 'scale', f, (sx, 1, sz))

    def look(self, f, dx=0.0, dz=0.0):
        for e, x in zip(self.eyes, (-0.24, 0.24)):
            key(e, 'location', f, (x + dx, -0.55, 0.62 + dz))

    def hover(self, start, end, amp=0.06, period=36):
        wiggle(self.torso, 'location', start, end, amp, period, index=2, base=0.55)

    def arm(self, side, f, up=0.0, fwd=0.0, twist=0.0, interp=None):
        """up: radians the arm swings out/up sideways (0 = down, ~2.6 = straight up). fwd: forward swing."""
        piv = self.armL if side == 'L' else self.armR
        s = -1 if side == 'L' else 1
        key(piv, 'rotation_euler', f, (fwd, -s * (0.18 + up), twist), interp)

    def wave(self, start, cycles=3, side='R', period=8):
        self.arm(side, start, up=2.5)
        piv = self.armL if side == 'L' else self.armR
        s = -1 if side == 'L' else 1
        f = start + 4
        for i in range(cycles * 2):
            key(piv, 'rotation_euler', f, (0, -s * (0.18 + 2.5), (0.45 if i % 2 else -0.45)))
            f += period // 2
        key(piv, 'rotation_euler', f, (0, -s * (0.18 + 2.5), 0))
        return f

    def smile_(self, f, k=1.0):
        key(self.mouth, 'scale', f, (k, 1, k))
        key(self.mouthO, 'scale', f, (0, 0, 0))

    def gasp(self, f, k=1.0):
        key(self.mouth, 'scale', f, (0, 0, 0))
        key(self.mouthO, 'scale', f, (k, 1, k))

    def squash(self, f, sq, interp=None):
        """sq > 1 stretches tall, < 1 squashes (volume kept)."""
        w = 1 / math.sqrt(sq)
        s = self.root.scale[2] if False else 1
        key(self.torso, 'scale', f, (w, w, sq), interp)


def save_usd(path):
    """Export the whole stage (meshes, materials, camera, lights, animation) as OpenUSD."""
    bpy.ops.wm.usd_export(filepath=path, export_animation=True, export_materials=True, export_lights=True, export_cameras=True, evaluation_mode='RENDER')


# ---------------------------------------------------------------- props


def diamond(name, loc, size, m, parent=None):
    """A keyframe diamond."""
    ob = rbox(name, loc, (size, size, size), size * 0.12, m, parent, segs=3)
    ob.rotation_euler = (0, math.pi / 4, 0)
    return ob


def lightbulb(name, loc, scale=1.0, glow=8.0):
    root = empty(name, loc)
    root.scale = (scale, scale, scale)
    glass = mat(name + 'Glass', (1.0, 0.92, 0.6), rough=0.1, emit=(1.0, 0.8, 0.35), strength=glow)
    sphere(name + 'Bulb', (0, 0, 0.28), (0.34, 0.34, 0.38), glass, root)
    metal = mat(name + 'Metal', (0.75, 0.72, 0.68), rough=0.3, metal=1.0)
    for i in range(3):
        cylinder(name + 'Thread%d' % i, (0, 0, -0.1 - i * 0.08), 0.16 - i * 0.012, 0.07, metal, root)
    cylinder(name + 'Tip', (0, 0, -0.33), 0.07, 0.06, mat(name + 'TipMat', (0.1, 0.1, 0.1), rough=0.5), root)
    l = bpy.data.objects.new(name + 'Light', bpy.data.lights.new(name + 'Light', 'POINT'))
    l.data.energy = 120 * glow / 8
    l.data.color = (1.0, 0.8, 0.45)
    l.data.shadow_soft_size = 0.3
    link(l)
    l.parent = root
    l.location = (0, 0, 0.3)
    return root


def magnifier(name, parent, loc=(0, 0, 0), rot=(0, 0, 0)):
    root = empty(name, loc, parent)
    root.rotation_euler = rot
    rim = mat(name + 'Rim', (0.12, 0.12, 0.14), rough=0.3, metal=0.8)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.3, minor_radius=0.04, major_segments=48, minor_segments=12, location=(0, 0, 0), rotation=(math.pi / 2, 0, 0))
    t = bpy.context.active_object
    _finish(t, name + 'Ring', root)
    t.location = (0, 0, 0.42)
    assign(t, rim)
    glass = mat(name + 'Glass', (0.85, 0.95, 1.0), rough=0.05, emit=(0.7, 0.9, 1.0), strength=0.25, alpha=0.35)
    g = sphere(name + 'Lens', (0, 0, 0.42), (0.28, 0.02, 0.28), glass, root, seg=32)
    cylinder(name + 'Handle', (0, 0, 0.0), 0.045, 0.32, mat(name + 'Grip', CORAL, rough=0.5), root)
    return root


def paper(name, loc, parent=None, lines=6):
    root = empty(name, loc, parent)
    rbox(name + 'Sheet', (0, 0, 0), (0.62, 0.02, 0.8), 0.02, mat(name + 'Mat', (0.97, 0.96, 0.92), rough=0.7), root, segs=2)
    ink = mat(name + 'Ink', (0.3, 0.3, 0.38), rough=0.8)
    for i in range(lines):
        w = 0.44 if i % 3 != 2 else 0.28
        rbox(name + 'Line%d' % i, (-(0.44 - w) / 2, -0.015, 0.28 - i * 0.1), (w, 0.01, 0.035), 0.012, ink, root, segs=2)
    return root


# ---------------------------------------------------------------- acting extras


def eyes_power(c, f, strength, interp=None):
    """Turn Michelangelo's eyes on or off (emission strength keyframe): 0 = dark, ~3 = awake."""
    node = c.m_eye.node_tree.nodes['Principled BSDF'].inputs['Emission Strength']
    node.default_value = strength
    node.keyframe_insert('default_value', frame=f)


def wink(c, f, side='R', dur=8):
    e = c.eyeR if side == 'R' else c.eyeL
    key(e, 'scale', f - 1, (1, 1, 1))
    key(e, 'scale', f + 2, (1.15, 1, 0.08))
    key(e, 'scale', f + dur, (1.15, 1, 0.08))
    key(e, 'scale', f + dur + 3, (1, 1, 1))


# ---------------------------------------------------------------- a creator's desk (the world Michelangelo lives in)
# Scale: Michelangelo is about 8 cm tall here, so 1 unit is about 3.3 cm; it fits in a pencil cup.


def heart(name, loc, size, m, parent=None, rot=(0, 0, 0)):
    root = empty(name, loc, parent)
    root.rotation_euler = rot
    root.scale = (size, size, size)
    sphere(name + 'L', (-0.28, 0, 0.18), (0.36, 0.36, 0.36), m, root, seg=24)
    sphere(name + 'R', (0.28, 0, 0.18), (0.36, 0.36, 0.36), m, root, seg=24)
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=0.62, depth=0.75, location=(0, 0, 0), rotation=(math.pi, 0, 0))
    cone = bpy.context.active_object
    _finish(cone, name + 'Tip', root)
    cone.location = (0, 0, -0.25)
    cone.scale = (1, 0.58, 1)
    assign(cone, m)
    return root


def phone(name, loc, clock='3:12', notes=(), rot_z=0.0, glow=1.0):
    """A phone lying face up with a lock screen: clock and notification cards [(title, body, heart?), ...].
    Returns the root and the list of card roots (animate their scale to make them arrive)."""
    root = empty(name, loc)
    root.rotation_euler = (-math.pi / 2, 0, rot_z)
    rbox(name + 'Body', (0, 0, 0), (2.35, 0.24, 4.8), 0.35, mat(name + 'BodyM', (0.05, 0.05, 0.07), rough=0.25, coat=1.0), root)
    rbox(name + 'Screen', (0, -0.125, 0), (2.18, 0.02, 4.6), 0.28, mat(name + 'ScreenM', (0.05, 0.07, 0.16), rough=0.15, emit=(0.06, 0.09, 0.22), strength=glow), root, segs=3)
    white = mat(name + 'Txt', (1, 1, 1), emit=(1, 1, 1), strength=1.6 * glow)
    text(name + 'Clock', clock, (0, -0.15, 1.45), 0.75, white, root, font='Montserrat-Bold.ttf', extrude=0.005)
    cardm = mat(name + 'Card', (0.85, 0.87, 0.95), rough=0.4, emit=(0.8, 0.83, 0.95), strength=0.55 * glow)
    ink = mat(name + 'Ink', (0.04, 0.04, 0.06), rough=0.6)
    red = mat(name + 'Heart', (1.0, 0.15, 0.25), emit=(1.0, 0.1, 0.2), strength=1.0)
    cards = []
    for i, n in enumerate(notes):
        title, body = n[0], n[1]
        cr = empty(name + 'Note%d' % i, (0, -0.14, 0.55 - i * 0.78), root)
        rbox(name + 'NoteBox%d' % i, (0, 0, 0), (1.98, 0.02, 0.66), 0.14, cardm, cr, segs=3)
        text(name + 'NoteT%d' % i, title, (-0.86, -0.02, 0.12), 0.17, ink, cr, font='Montserrat-Black.ttf', extrude=0.004, align='LEFT')
        text(name + 'NoteB%d' % i, body, (-0.86, -0.02, -0.14), 0.15, ink, cr, font='Montserrat-Bold.ttf', extrude=0.004, align='LEFT')
        if len(n) > 2 and n[2]:
            heart(name + 'NoteH%d' % i, (0.8, -0.03, -0.12), 0.16, red, cr)
        cards.append(cr)
    return root, cards


def pencil_cup(name, loc, r=1.55, h=3.0, color=(0.95, 0.5, 0.35)):
    """An open ceramic cup with a few pencils: Michelangelo's bed."""
    root = empty(name, loc)
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=r, depth=h, location=(0, 0, 0))
    cup = bpy.context.active_object
    bm = bmesh.new()
    bm.from_mesh(cup.data)
    top = [f for f in bm.faces if f.normal.z > 0.9]
    bmesh.ops.delete(bm, geom=top, context='FACES')
    bm.to_mesh(cup.data)
    bm.free()
    sol = cup.modifiers.new('solid', 'SOLIDIFY')
    sol.thickness = 0.12
    bv = cup.modifiers.new('bevel', 'BEVEL')
    bv.width = 0.05
    bv.segments = 3
    _finish(cup, name + 'Cup', root)
    cup.location = (0, 0, h / 2)
    assign(cup, mat(name + 'Glaze', color, rough=0.2, coat=0.8))
    wood = mat(name + 'Wood', (0.9, 0.7, 0.4), rough=0.6)
    lead = mat(name + 'Lead', (0.1, 0.1, 0.1), rough=0.5)
    paint = [(1.0, 0.8, 0.1), (0.2, 0.5, 0.95), (0.95, 0.3, 0.3)]
    for i, (dx, dy, tilt) in enumerate([(-0.9, 0.7, 0.25), (0.95, 0.75, -0.3), (-0.2, 1.05, 0.1)]):
        p = empty(name + 'Pencil%d' % i, (dx, dy, 0.2), root)
        p.rotation_euler = (0.1, tilt, 0)
        cylinder(name + 'PBody%d' % i, (0, 0, 2.6), 0.13, 5.2, mat(name + 'Paint%d' % i, paint[i], rough=0.4), p, verts=6)
        bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=0.13, depth=0.45, location=(0, 0, 0))
        tip = bpy.context.active_object
        _finish(tip, name + 'PTip%d' % i, p)
        tip.location = (0, 0, 5.42)
        assign(tip, wood)
    return root


def mug(name, loc, color=(0.92, 0.9, 0.86)):
    root = empty(name, loc)
    glaze = mat(name + 'Glaze', color, rough=0.25, coat=0.6)
    cylinder(name + 'Body', (0, 0, 1.5), 1.35, 3.0, glaze, root, verts=48)
    cylinder(name + 'Coffee', (0, 0, 2.85), 1.2, 0.05, mat(name + 'Coffee', (0.12, 0.06, 0.03), rough=0.1), root, verts=48)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.62, minor_radius=0.17, major_segments=32, minor_segments=12, location=(0, 0, 0), rotation=(math.pi / 2, 0, 0))
    hdl = bpy.context.active_object
    _finish(hdl, name + 'Handle', root)
    hdl.location = (1.4, 0, 1.6)
    assign(hdl, glaze)
    return root


def sleeve(name, loc, rot_z=0.0, color=(0.28, 0.3, 0.36)):
    """A sleeping person's hoodie arm across the desk (sweater paw, no hand)."""
    root = empty(name, loc)
    root.rotation_euler = (0, 0, rot_z)
    fab = mat(name + 'Fabric', color, rough=0.9, sheen=1.0)
    sphere(name + 'Arm', (0, 0, 1.6), (9.0, 2.2, 1.7), fab, root)
    bpy.ops.mesh.primitive_torus_add(major_radius=1.55, minor_radius=0.45, major_segments=40, minor_segments=12, location=(0, 0, 0), rotation=(0, math.pi / 2, 0))
    cuff = bpy.context.active_object
    _finish(cuff, name + 'Cuff', root)
    cuff.location = (-8.3, 0, 1.55)
    cuff.scale = (1, 1.25, 1.0)
    assign(cuff, fab)
    sphere(name + 'Paw', (-8.9, 0, 1.3), (1.0, 1.5, 1.05), fab, root)
    return root


def monitor(name, loc, size=(34, 19), label='EXPORTING  12%', glow=1.2):
    """A big monitor behind the desk showing a timeline; returns (root, progress-fill object, label text)."""
    root = empty(name, loc)
    w, h = size
    rbox(name + 'Bezel', (0, 0, 0), (w, 0.8, h), 0.5, mat(name + 'BezelM', (0.04, 0.04, 0.05), rough=0.3, coat=0.6), root)
    rbox(name + 'Screen', (0, -0.42, 0), (w - 1.2, 0.05, h - 1.2), 0.3, mat(name + 'ScreenM', (0.05, 0.06, 0.1), rough=0.3, emit=(0.06, 0.08, 0.14), strength=glow), root, segs=2)
    cols = [(0.95, 0.35, 0.25), (1.0, 0.75, 0.15), (0.3, 0.75, 0.7), (0.55, 0.45, 0.9), (0.35, 0.6, 1.0)]
    k = 0
    for row in range(5):
        x = -w / 2 + 2.5
        while True:
            ln = 2.0 + ((row * 7 + k * 3) % 5) * 0.9
            if x + ln > w / 2 - 1.5:
                break
            c = cols[(row + k) % len(cols)]
            rbox(name + 'Clip%d' % k, (x + ln / 2, -0.47, -h / 2 + 3.0 + row * 1.6), (ln, 0.05, 1.1), 0.2,
                 mat(name + 'ClipM%d' % k, c, rough=0.4, emit=c, strength=0.6 * glow), root, segs=2)
            x += ln + 0.35
            k += 1
    rbox(name + 'BarBg', (0, -0.47, h / 2 - 4.2), (w * 0.6, 0.05, 0.9), 0.4, mat(name + 'BarBgM', (0.2, 0.2, 0.25), emit=(0.2, 0.2, 0.25), strength=0.4 * glow), root, segs=2)
    fill_root = empty(name + 'FillRoot', (-w * 0.3, -0.5, h / 2 - 4.2), root)
    fill = rbox(name + 'Fill', (w * 0.3, 0, 0), (w * 0.6, 0.05, 0.75), 0.35, mat(name + 'FillM', (1.0, 0.45, 0.2), emit=(1.0, 0.42, 0.18), strength=1.6 * glow), fill_root, segs=2)
    lab = text(name + 'Label', label, (0, -0.5, h / 2 - 2.4), 1.0, mat(name + 'LabelM', (1, 1, 1), emit=(1, 1, 1), strength=1.4 * glow), root, font='Montserrat-Bold.ttf', extrude=0.01)
    return root, fill_root, lab


def sticky(name, loc, body, color=(1.0, 0.86, 0.3), rot=(math.pi / 2, 0, 0), size=3.2):
    root = empty(name, loc)
    root.rotation_euler = rot
    rbox(name + 'Pad', (0, 0, 0), (size, 0.03, size), 0.05, mat(name + 'PadM', color, rough=0.8), root, segs=2)
    lines = body.split('\n')
    for i, ln in enumerate(lines):
        text(name + 'L%d' % i, ln, (0, -0.03, (len(lines) - 1) * 0.32 - i * 0.64), 0.5, mat(name + 'InkM%d' % i, (0.1, 0.1, 0.15), rough=0.6), root, font='Montserrat-Black.ttf', extrude=0.005)
    return root


def desk_set(time='night', wall=True):
    """The creator's desk at night (monitor glow, dark room), at dawn (blue window) or in the morning (warm sun).
    Returns a dict of the lights so a shot can animate the time of day."""
    sc = bpy.context.scene
    top = mat('DeskTop', (0.42, 0.26, 0.15), rough=0.45, coat=0.3)
    rbox('Desk', (0, 6, -0.6), (140, 60, 1.2), 0.3, top, segs=2)
    if wall:
        rbox('Wall', (0, 32, 30), (160, 1, 70), 0.2, mat('WallM', (0.55, 0.52, 0.6), rough=0.95), segs=1)
    lights = {}
    lights['moon'] = area_light('Moon', (-30, -18, 40), (0, 4, 0), 0, 30, (0.55, 0.65, 1.0))
    lights['screen'] = area_light('ScreenLight', (0, 20, 12), (0, -4, 1), 0, 30, (0.6, 0.75, 1.0))
    lights['sun'] = area_light('Sun', (-40, -10, 30), (0, 6, 0), 0, 25, (1.0, 0.8, 0.55))
    lights['fill'] = area_light('FillDesk', (25, -30, 18), (0, 0, 2), 0, 30, (0.9, 0.9, 1.0))
    w = sc.world.node_tree.nodes['Background']
    if time == 'night':
        lights['moon'].data.energy = 2500; lights['screen'].data.energy = 9000; lights['fill'].data.energy = 600
        w.inputs[0].default_value = (0.02, 0.025, 0.06, 1); w.inputs[1].default_value = 0.4
    elif time == 'dawn':
        lights['moon'].data.energy = 3500; lights['screen'].data.energy = 6000; lights['fill'].data.energy = 1500; lights['sun'].data.energy = 3000
        lights['sun'].data.color = (1.0, 0.6, 0.45)
        w.inputs[0].default_value = (0.25, 0.25, 0.4, 1); w.inputs[1].default_value = 0.5
    else:
        lights['sun'].data.energy = 16000; lights['fill'].data.energy = 3000; lights['screen'].data.energy = 2500
        w.inputs[0].default_value = (0.9, 0.85, 0.8, 1); w.inputs[1].default_value = 0.6
    return lights


def sleeper(name, loc, rot_z=0.0, hoodie=(0.3, 0.33, 0.42), hair=(0.22, 0.12, 0.06), skin=(0.85, 0.6, 0.45)):
    """A person asleep face-down on folded arms, seen from behind: hoodie back and hood, arms, hair and an ear.
    Returns a dict with root, back (breathe with its scale) and head (lift it to wake them)."""
    root = empty(name, loc)
    root.rotation_euler = (0, 0, rot_z)
    fab = mat(name + 'Hoodie', hoodie, rough=0.9, sheen=1.0)
    hr = mat(name + 'Hair', hair, rough=0.6, sheen=0.5)
    sk = mat(name + 'Skin', skin, rough=0.5, sss=0.3)
    back = empty(name + 'Back', (0, -6.0, 0), root)
    sphere(name + 'BackMesh', (0, 0, 2.6), (6.0, 3.4, 3.8), fab, back)
    for side in (-1, 1):
        arm = sphere(name + 'Arm%d' % side, (side * 2.6, 0.8, 1.25), (5.2, 1.6, 1.25), fab, root)
        arm.rotation_euler = (0, 0, side * 0.32)
        sphere(name + 'Paw%d' % side, (side * -2.2, 3.2, 1.2), (1.3, 1.5, 1.1), fab, root)
    head = empty(name + 'HeadPivot', (0, -1.4, 2.4), root)
    sphere(name + 'Hood', (0, -2.2, 1.3), (3.6, 2.0, 2.2), fab, head)
    sphere(name + 'Head', (0, 0.9, 1.7), (2.7, 2.9, 2.6), hr, head)
    sphere(name + 'Ear', (2.55, 0.8, 1.5), (0.45, 0.75, 0.95), sk, head, seg=24)
    sphere(name + 'Neck', (0, -1.0, 0.9), (1.4, 1.2, 1.2), sk, head, seg=24)
    return {'root': root, 'back': back, 'head': head}


def keyboard(name, loc, w=18.0, d=6.0, rot_z=0.0):
    """A big keyboard (Michelangelo can stand on the keys). Returns (root, list of key objects by row)."""
    root = empty(name, loc)
    root.rotation_euler = (0, 0, rot_z)
    rbox(name + 'Base', (0, 0, 0.3), (w, d, 0.6), 0.25, mat(name + 'BaseM', (0.12, 0.12, 0.14), rough=0.4), root, segs=2)
    keym = mat(name + 'KeyM', (0.86, 0.86, 0.88), rough=0.5)
    rows = []
    cols = int(w // 1.45)
    for r in range(4):
        row = []
        for c in range(cols):
            x = -w / 2 + 0.95 + c * 1.45
            y = -d / 2 + 1.0 + r * 1.35
            row.append(rbox(name + 'K%d_%d' % (r, c), (x, y, 0.75), (1.2, 1.1, 0.35), 0.12, keym, root, segs=2))
        rows.append(row)
    return root, rows


def key_light(target, loc, energy=160, color=(0.75, 0.85, 1.0), size=3.0, name='CharLight'):
    """A soft light on the character so it reads in dark scenes."""
    return area_light(name, loc, target, energy, size, color)
