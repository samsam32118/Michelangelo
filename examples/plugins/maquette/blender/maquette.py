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


# ---------------------------------------------------------------- v8: people as traces, and a few acting beats
# Like early Pixar, show people through what they leave on screen (a hand, a sleeve, a mug) rather than a full figure.


def hand(name, loc, rot=(0, 0, 0), skin=(0.86, 0.62, 0.48), sleeve=(0.3, 0.33, 0.42), point=False):
    """A stylized hand coming out of a hoodie sleeve, palm down, fingers along +Y.
    Returns a dict: root, fingers (4 pivots, index first; rotate x to curl), thumb, sleeve. point=True curls all but the index."""
    root = empty(name, loc)
    root.rotation_euler = rot
    sk = mat(name + 'Skin', skin, rough=0.5, sss=0.25)
    fab = mat(name + 'Sleeve', sleeve, rough=0.9, sheen=1.0)
    rbox(name + 'Palm', (0, 0, 0.45), (2.7, 3.0, 0.95), 0.42, sk, root, segs=4)
    fingers = []
    for i, (x, ln) in enumerate([(0.95, 2.0), (0.32, 2.2), (-0.32, 2.05), (-0.92, 1.6)]):
        piv = empty(name + 'F%d' % i, (x, 1.35, 0.5), root)
        sphere(name + 'Fing%d' % i, (0, ln / 2, 0), (0.3, ln / 2, 0.3), sk, piv, seg=24)
        if point and i > 0:
            piv.rotation_euler = (-1.6, 0, 0)
        else:
            piv.rotation_euler = (-0.25, 0, 0)
        fingers.append(piv)
    th = empty(name + 'Thumb', (1.35, -0.2, 0.4), root)
    sphere(name + 'ThumbMesh', (0.45, 0.6, 0), (0.33, 0.9, 0.33), sk, th, seg=24)
    th.rotation_euler = (0, 0, -0.6)
    sl = empty(name + 'SleeveRoot', (0, -1.6, 0.55), root)
    sphere(name + 'SleeveMesh', (0, -3.6, 0.2), (1.9, 3.9, 1.5), fab, sl)
    bpy.ops.mesh.primitive_torus_add(major_radius=1.55, minor_radius=0.42, major_segments=40, minor_segments=12, location=(0, 0, 0), rotation=(math.pi / 2, 0, 0))
    cuff = bpy.context.active_object
    _finish(cuff, name + 'Cuff', sl)
    cuff.location = (0, -0.1, 0.2)
    cuff.scale = (1.15, 1, 0.95)
    assign(cuff, fab)
    return {'root': root, 'fingers': fingers, 'thumb': th, 'sleeve': sl}


def blush(c, f, strength):
    """Michelangelo's cheeks glow (0.7 is normal, ~4 is a happy blush)."""
    node = bpy.data.materials[c.name + 'Blush'].node_tree.nodes['Principled BSDF'].inputs['Emission Strength']
    node.default_value = strength
    node.keyframe_insert('default_value', frame=f)


def fix_beret(c, f, side='R'):
    """The ritual before work: reach up, tug the beret straight, a little nod. Takes about 12 frames."""
    c.arm(side, f, up=0.4)
    c.arm(side, f + 4, up=2.6, fwd=-0.3)
    key(c.beret, 'rotation_euler', f + 4, (0.25, -0.4, 0.15))
    key(c.beret, 'rotation_euler', f + 8, (0.05, -0.12, -0.05))
    key(c.beret, 'rotation_euler', f + 11, (0.12, -0.22, 0))
    c.arm(side, f + 12, up=0.4)
    key(c.head, 'rotation_euler', f + 8, (0.18, 0, 0))
    key(c.head, 'rotation_euler', f + 12, (0.0, 0, 0))


def tremble(c, start, end, amp=0.04):
    """Scared shiver: tiny fast side-to-side on the torso."""
    f, s = start, 1
    while f <= end:
        key(c.torso, 'location', f, (amp * s, 0, 0.55))
        f += 1
        s = -s
    key(c.torso, 'location', end + 1, (0, 0, 0.55))


def thimble(name, loc):
    """A thimble of coffee: a thank-you sized for Michelangelo."""
    root = empty(name, loc)
    metal = mat(name + 'Metal', (0.8, 0.78, 0.74), rough=0.25, metal=1.0)
    cylinder(name + 'Body', (0, 0, 0.55), 0.55, 1.1, metal, root, verts=40)
    cylinder(name + 'Coffee', (0, 0, 1.08), 0.47, 0.04, mat(name + 'Coffee', (0.12, 0.06, 0.03), rough=0.1), root, verts=40)
    return root


# ---------------------------------------------------------------- v9: the croissant film (a bakery video, the edits piled on it, and the chisel)
# Everything below is additive: new props and helpers only. Cut-outs face -Y (towards the camera), like text().

import random
from mathutils import Matrix


def _rng(name):
    return random.Random(sum(ord(ch) * (i + 1) for i, ch in enumerate(name)))


def _nodes(m):
    nt = m.node_tree
    return nt, nt.nodes['Principled BSDF']


def grad_mat(name, low, high, axis=2, rough=0.4, coat=0.0, sss=0.0, glow=0.0, alpha=1.0, mid=None):
    """A material that blends low -> high along the object's own box (axis 0 x, 1 y, 2 z). glow > 0 also emits it."""
    m = mat(name, high, rough=rough, coat=coat, sss=sss, alpha=alpha)
    nt, b = _nodes(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    nt.links.new(sep.outputs[axis], ramp.inputs['Fac'])
    els = ramp.color_ramp.elements
    els[0].color = (*low, 1)
    els[1].color = (*high, 1)
    if mid:
        e = els.new(mid[0])
        e.color = (*mid[1], 1)
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    if glow:
        nt.links.new(ramp.outputs['Color'], b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = glow
    return m


def marble_mat(name, color=(0.93, 0.92, 0.9), vein=(0.62, 0.62, 0.66), rough=0.5, sss=0.0):
    """White stone with faint grey veins (noise)."""
    m = mat(name, color, rough=rough, sss=sss)
    nt, b = _nodes(m)
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 6.0
    noise.inputs['Detail'].default_value = 8.0
    noise.inputs['Distortion'].default_value = 3.0
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.46
    ramp.color_ramp.elements[0].color = (*vein, 1)
    ramp.color_ramp.elements[1].position = 0.54
    ramp.color_ramp.elements[1].color = (*color, 1)
    nt.links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    return m


def soft_mat(name, color=(1, 1, 1), glow=0.6, alpha=0.45):
    """Soft translucent white (steam, dust puffs): emissive, see-through."""
    return mat(name, color, rough=0.9, emit=color, strength=glow, alpha=alpha)


def key_alpha(m, f, a):
    """Keyframe a material's alpha (fade in / out)."""
    inp = m.node_tree.nodes['Principled BSDF'].inputs['Alpha']
    inp.default_value = a
    inp.keyframe_insert('default_value', frame=f)


def key_glow(m, f, s):
    inp = m.node_tree.nodes['Principled BSDF'].inputs['Emission Strength']
    inp.default_value = s
    inp.keyframe_insert('default_value', frame=f)


def _descend(ob):
    out = [ob]
    for ch in ob.children:
        out.extend(_descend(ch))
    return out


def show(ob, f, on=True, tree=True):
    """Keyframe render visibility at frame f (on or off) for ob and, with tree, all its children. Holds until the next key."""
    for o in (_descend(ob) if tree else [ob]):
        o.hide_render = not on
        o.keyframe_insert('hide_render', frame=f)


def pop_in(ob, f, dur=6, k=1.0, over=1.18):
    """Scale 0 -> overshoot -> k, landing at f + dur (a cartoon bounce). Hidden (scale 0) before f."""
    z = (0.0, 0.0, 0.0)
    key(ob, 'scale', f - 1, z)
    key(ob, 'scale', f, (0.02, 0.02, 0.02))
    key(ob, 'scale', f + int(dur * 0.6), (k * over, k * over, k * over))
    key(ob, 'scale', f + int(dur * 0.8), (k * 0.95, k * 0.95, k * 0.95))
    key(ob, 'scale', f + dur, (k, k, k))


def grab(ob, target, f):
    """From frame f, ob follows target (a hand, say) from wherever it is at f: a Child Of constraint switched on at f.
    Call it after the target's animation is keyed."""
    sc = bpy.context.scene
    keep = sc.frame_current
    sc.frame_set(f)
    con = ob.constraints.new('CHILD_OF')
    con.target = target
    con.inverse_matrix = target.matrix_world.inverted()
    con.influence = 0.0
    con.keyframe_insert('influence', frame=f - 1)
    con.influence = 1.0
    con.keyframe_insert('influence', frame=f)
    for fc in _fcurves(ob):
        if 'influence' in fc.data_path:
            for kp in fc.keyframe_points:
                kp.interpolation = 'CONSTANT'
    sc.frame_set(keep)
    return con


def _font(cu, font):
    if FONT_DIR:
        try:
            cu.font = bpy.data.fonts.load(f'{FONT_DIR}/{font}', check_existing=True)
        except RuntimeError:
            pass


def small_caps(cu, scale=0.78):
    """Set a text curve in small caps (lower case drawn as smaller capitals)."""
    cu.small_caps_scale = scale
    for ch in cu.body_format:
        ch.use_small_caps = True


def text_widths(bodies, size, font='Montserrat-Bold.ttf', smallcaps=False):
    """Measured widths of several strings set in a font (one depsgraph update)."""
    obs = []
    for i, b in enumerate(bodies):
        cu = bpy.data.curves.new('_meas%d' % i, 'FONT')
        cu.body = b if b.strip() else '.'
        cu.size = size
        _font(cu, font)
        if smallcaps:
            small_caps(cu)
        obs.append(link(bpy.data.objects.new('_meas%d' % i, cu)))
    bpy.context.view_layer.update()
    out = [o.dimensions.x for o in obs]
    for o in obs:
        cu = o.data
        bpy.data.objects.remove(o)
        bpy.data.curves.remove(cu)
    return out


def wrap(body, size, maxw, font='Inter-Bold.ttf', smallcaps=False):
    """Greedy word wrap of body to lines no wider than maxw (measured)."""
    words = body.split()
    lines, cur = [], ''
    for w in words:
        cand = (cur + ' ' + w).strip()
        if cur and text_widths([cand], size, font, smallcaps)[0] > maxw:
            lines.append(cur)
            cur = w
        else:
            cur = cand
    if cur:
        lines.append(cur)
    return lines


def hand_text(name, body, loc, size, m, parent=None, font='Montserrat-Bold.ttf', jit_rot=0.06, jit_off=0.03,
              extrude=0.01, rot=(math.pi / 2, 0, 0), align='CENTER', seed=None):
    """Hand-lettered text: one object per letter with a little random tilt and offset. Returns (root, letters, width).
    The letters sit in the root's XY plane (the root faces -Y like text())."""
    r = _rng(seed or name)
    root = empty(name, loc, parent)
    root.rotation_euler = rot
    idx = [i for i, ch in enumerate(body) if ch.strip()]
    meas = text_widths([body] + [body[:i + 1] for i in idx] + [body[i] for i in idx], size, font)
    total = meas[0]
    n = len(idx)
    x0 = {'CENTER': -total / 2, 'LEFT': 0.0, 'RIGHT': -total}[align]
    letters = []
    for j, i in enumerate(idx):
        x = meas[1 + j] - meas[1 + n + j]
        t = text(name + '_%d' % j, body[i], (x0 + x + r.uniform(-jit_off, jit_off) * size, r.uniform(-jit_off, jit_off) * size * 1.5, 0),
                 size * r.uniform(0.94, 1.06), m, root, font=font, extrude=extrude, rot=(0, 0, r.uniform(-jit_rot, jit_rot)), align='LEFT')
        letters.append(t)
    return root, letters, total


def _poly_curve(name, pts, thick, m, parent=None, cyclic=False, loc=(0, 0, 0), radii=None, kind='POLY'):
    """A bevelled curve through points (x, y, z) in the parent's space: outlines, strokes, icons."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = thick
    cu.bevel_resolution = 3
    cu.use_fill_caps = True
    sp = cu.splines.new(kind)
    if kind == 'BEZIER':
        sp.bezier_points.add(len(pts) - 1)
        for i, p in enumerate(pts):
            bp = sp.bezier_points[i]
            bp.co = p
            bp.handle_left_type = bp.handle_right_type = 'AUTO'
            if radii:
                bp.radius = radii[i]
    else:
        sp.points.add(len(pts) - 1)
        for i, p in enumerate(pts):
            sp.points[i].co = (*p, 1)
            if radii:
                sp.points[i].radius = radii[i]
    sp.use_cyclic_u = cyclic
    ob = link(bpy.data.objects.new(name, cu))
    ob.data.materials.append(m)
    if parent:
        ob.parent = parent
    ob.location = loc
    return ob


def _rrect_pts(w, h, r, n=6):
    """Points around a rounded rectangle (x, 0, z), centred."""
    pts = []
    for cx, cz, a0 in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), 0, cz + r * math.sin(a)))
    return pts


def _shape_mesh(name, pts2d, depth, m, parent=None, loc=(0, 0, 0), bevel=0.0):
    """A flat cut-out: a polygon (x, z) extruded depth along Y, front face at y=0 facing -Y."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    front = [bm.verts.new((x, 0, z)) for x, z in pts2d]
    face = bm.faces.new(front)
    bmesh.ops.reverse_faces(bm, faces=[face]) if face.normal.y > 0 else None
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    for v in [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]:
        v.co.y += depth
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    if bevel:
        bv = ob.modifiers.new('bevel', 'BEVEL')
        bv.width = bevel
        bv.segments = 2
    ob.data.materials.append(m)
    if parent:
        ob.parent = parent
    ob.location = loc
    return ob


# --- the croissant


def croissant(name, loc, scale=1.0, parent=None, depth=1.0):
    """A golden croissant: a crescent of 7 rolled lobes (fat in the middle, thin horns curling down), lamination ridges
    and a glaze from deep amber on top to pale cream underneath. About 3.4 wide and 1.1 tall at scale 1; the horns
    curve forward (-Y, towards the camera) and down: the classic crescent. Returns a dict: root, lobes, anchors (2 empties on the top flanks, L then R).
    depth < 1 flattens it front to back without shearing (a relief, for the monitor's picture)."""
    root = empty(name, loc, parent)
    root.scale = (scale, scale, scale)
    m = grad_mat(name + 'Glaze', (0.96, 0.76, 0.45), (0.36, 0.12, 0.02), axis=2, rough=0.36, coat=0.5, sss=0.06,
                 mid=(0.45, (0.8, 0.38, 0.06)))
    nt, b = _nodes(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    wave = nt.nodes.new('ShaderNodeTexWave')
    wave.wave_type = 'BANDS'
    wave.bands_direction = 'Y'
    wave.inputs['Scale'].default_value = 3.2
    wave.inputs['Distortion'].default_value = 1.6
    wave.inputs['Detail'].default_value = 2.0
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.35
    bump.inputs['Distance'].default_value = 0.02
    nt.links.new(tc.outputs['Generated'], wave.inputs['Vector'])
    nt.links.new(wave.outputs['Fac'], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], b.inputs['Normal'])
    R, span = 1.7, 1.05
    lobes = []
    for i in range(-3, 4):
        t = i / 3
        a = t * span
        f = 1 - 0.62 * abs(t) ** 1.1
        sx, sy, sz = 0.3 + 0.16 * f, 0.62 * f + 0.06, 0.6 * f
        if abs(i) == 3:
            sx, sy, sz = 0.62, 0.17, 0.15
        x = R * math.sin(a) * (0.97 if abs(i) == 3 else 1)
        y = -R * (1 - math.cos(a)) * 0.9
        z = sz * 0.95 - 0.3 * abs(t) ** 2 + (0.06 if abs(i) == 3 else 0)
        sy *= depth
        y *= depth
        lob = sphere(name + 'Lobe%d' % (i + 3), (x, y, z), (sx, sy, sz), m, root, seg=40)
        sgn = 1 if i > 0 else -1
        curl = 0.16 * abs(i) if abs(i) < 3 else 0.85
        lob.rotation_euler = (0.1 * t, curl * sgn, a * 0.75 * depth)
        lobes.append(lob)
    anchors = [empty(name + 'Anchor' + s, (sx_ * 0.95, 0.15, 0.62), root) for s, sx_ in (('L', -1), ('R', 1))]
    return {'root': root, 'lobes': lobes, 'anchors': anchors, 'top': (0, 0.05, 1.08)}


# --- steam


def steam_wisp(name, loc, height=3.0, parent=None, grow=None, idle=None, width=0.12, seed=None):
    """A soft S-curve wisp of steam rising from loc (z up). grow=f grows it over 8 frames (bevel_factor_end 0 -> 1);
    idle=(start, end) adds a gentle curl. Shadowless and see-through, so a mask in front can clip it."""
    r = _rng(seed or name)
    h = height
    pts = [(0, 0, 0), (0.28 * h * 0.33, 0, h * 0.3), (-0.3 * h * 0.33, 0, h * 0.62), (0.16 * h * 0.33, 0, h)]
    sm = soft_mat(name + 'M', (1.0, 0.98, 0.95), 0.6, 0.45)
    nt, b = _nodes(sm)
    b.inputs['Base Color'].default_value = (0.55, 0.54, 0.53, 1)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeMapRange')
    ramp.inputs['To Min'].default_value = 0.4
    ramp.inputs['To Max'].default_value = 0.04
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    nt.links.new(sep.outputs[2], ramp.inputs['Value'])
    nt.links.new(ramp.outputs['Result'], b.inputs['Alpha'])
    ob = _poly_curve(name, pts, width * h / 3, sm, parent, loc=loc,
                     radii=[1.4, 1.2, 0.8, 0.25], kind='BEZIER')
    ob.data.bevel_resolution = 4
    ob.data.resolution_u = 16
    ob.visible_shadow = False
    if grow is not None:
        steam_grow(ob, grow)
    if idle:
        steam_idle(ob, idle[0], idle[1], seed=r.random())
    return ob


def steam_grow(ob, f, dur=8):
    cu = ob.data
    cu.bevel_factor_end = 0.0
    cu.keyframe_insert('bevel_factor_end', frame=f)
    cu.bevel_factor_end = 1.0
    cu.keyframe_insert('bevel_factor_end', frame=f + dur)


def steam_idle(ob, start, end, amp=0.18, period=30, seed=0.0):
    """A slow curl: the upper control points sway side to side."""
    pts = ob.data.splines[0].bezier_points
    base = [p.co.copy() for p in pts]
    fr = start
    while fr <= end:
        for i in range(1, len(pts)):
            ph = (fr - start) / period * 2 * math.pi + i * 1.3 + seed * 6
            pts[i].co = (base[i].x + amp * i * math.sin(ph), base[i].y + amp * 0.5 * math.cos(ph), base[i].z)
            pts[i].keyframe_insert('co', frame=fr)
            pts[i].handle_left_type = pts[i].handle_right_type = 'AUTO'
        fr += max(2, period // 4)


# --- the video monitor


def video_monitor(name, loc, size=(34, 19), filename='croissant_FINAL.mp4', glow=1.0, floor=0.0,
                  files=('croissant_FINAL.mp4', 'croissant_FINAL_v2.mp4', 'croissant_FINAL_final_v412.mp4'),
                  caption='Fresh at 7am.', steam=True, ui_x=8.0):
    """A chunky monitor playing a croissant video. loc is the centre of the picture; the picture is size - 2
    (32 x 17 by default) with a 1.6 bezel, a 2.4 chin, a neck and a 10 x 5 base plate on the desk at z=floor.
    ui_x keeps the caption (lower-left) and the file name (lower-right) within +-ui_x of the centre, so they stay in a
    4:5 frame (the 16:9 picture's sides crop). The picture is a warm bakery plate plus a shallow 3D diorama 0.3-1.5 in front of the glass (board, croissant,
    steam) that the robot can touch. Returns a dict:
      root, pw, ph, border, chin, glass_y (world y of the picture), front_y (world y of the bezel front),
      diorama, croissant (dict), steam, board, caption (hidden until monitor_caption), caption_mat,
      files (3 filename texts, show one with monitor_file), playhead, slots (4 empties at -0.4, -0.6, -0.8, -1.0 in
      front of the glass for the junk layers), plate (the flat picture)."""
    root = empty(name, loc)
    pw, ph = size[0] - 2, size[1] - 2
    b, chin = 1.6, 2.4
    W, H = pw + 2 * b, ph + 2 * b + chin
    shell = mat(name + 'Shell', (0.07, 0.07, 0.085), rough=0.32, coat=0.6)
    rbox(name + 'Housing', (0, 0.6, -chin / 2), (W, 2.0, H), 0.42, shell, root, segs=4)
    rbox(name + 'Back', (0, 2.0, -chin / 2 + 0.5), (W * 0.7, 2.0, H * 0.6), 1.2, shell, root, segs=4)
    rbox(name + 'Lip', (0, -0.38, 0), (pw + 0.5, 0.08, ph + 0.5), 0.2, mat(name + 'LipM', (0.02, 0.02, 0.025), rough=0.2), root, segs=2)
    zb = -ph / 2 - b - chin
    sphere(name + 'Power', (W / 2 - 1.6, -0.42, -ph / 2 - b - chin / 2), (0.16, 0.06, 0.16), mat(name + 'PowerM', (0.3, 1.0, 0.5), emit=(0.3, 1.0, 0.5), strength=3), root, seg=16)
    gy = -0.44
    # stand
    neck_top = zb + 0.6
    neck_len = max(0.6, loc[2] + neck_top - floor)
    rbox(name + 'Neck', (0, 0.9, neck_top - neck_len / 2), (3.4, 1.0, neck_len), 0.35, shell, root, segs=3)
    rbox(name + 'Base', (0, -1.5, floor - loc[2] + 0.22), (10, 5, 0.44), 0.2, shell, root, segs=3)
    # the picture: warm plate with bokeh
    plate = rbox(name + 'Plate', (0, gy, 0), (pw, 0.04, ph), 0.25,
                 grad_mat(name + 'PlateM', (0.42, 0.2, 0.1), (1.0, 0.9, 0.74), axis=2, glow=0.9 * glow, rough=0.6,
                          mid=(0.42, (1.0, 0.72, 0.5))), root, segs=2)
    plate.modifiers.remove(plate.modifiers['sub'])
    bok = soft_mat(name + 'Bokeh', (1.0, 0.95, 0.82), 1.1 * glow, 0.35)
    for i, (x, z, rr) in enumerate([(-0.36, 0.28, 2.6), (-0.12, 0.36, 1.6), (0.18, 0.3, 2.2), (0.38, 0.12, 1.4), (-0.42, -0.05, 1.3)]):
        d = cylinder(name + 'Bokeh%d' % i, (x * pw, gy - 0.03 - i * 0.004, z * ph), rr, 0.01, bok, root, rot=(math.pi / 2, 0, 0), verts=40)
        d.visible_shadow = False
    # timeline bar, playhead and the file names
    ui = mat(name + 'UI', (0.2, 0.15, 0.13), emit=(0.25, 0.18, 0.14), strength=0.6 * glow, alpha=0.75)
    rbox(name + 'Bar', (0, gy - 0.05, -ph / 2 + 0.55), (pw - 1.2, 0.03, 0.16), 0.07, ui, root, segs=2)
    play = empty(name + 'Playhead', (-(pw - 1.2) / 2 + 2.0, gy - 0.08, -ph / 2 + 0.55), root)
    white = mat(name + 'UIWhite', (1, 1, 1), emit=(1, 0.98, 0.95), strength=1.6 * glow)
    sphere(name + 'PlayKnob', (0, 0, 0), (0.18, 0.05, 0.18), white, play, seg=20)
    rbox(name + 'PlayFill', (-(pw - 1.2) / 2 + 1.0, gy - 0.07, -ph / 2 + 0.55), (2.0, 0.03, 0.16), 0.07, white, root, segs=2)
    ink = mat(name + 'FileInk', (0.25, 0.14, 0.08), emit=(0.25, 0.14, 0.08), strength=0.3 * glow)
    fobs = []
    names = list(files)
    if filename not in names:
        names[0] = filename
    for i, fn in enumerate(names):
        t = text(name + 'File%d' % i, fn, (min(ui_x, pw / 2 - 0.7), gy - 0.06, -ph / 2 + 1.15), 0.56, ink, root, font='JetBrainsMono-Bold.ttf', extrude=0.005, align='RIGHT')
        fobs.append(t)
    start = names.index(filename)
    for i, t in enumerate(fobs):
        show(t, 0, i == start)
    # the diorama: a board, the croissant and its steam, shallow (y squashed) so it reads as the video's picture
    dio = empty(name + 'Diorama', (0, gy - 0.6, -ph / 2 + 5.6), root)
    wood = grad_mat(name + 'Wood', (0.5, 0.28, 0.13), (0.72, 0.45, 0.24), axis=2, rough=0.55, coat=0.2)
    board = cylinder(name + 'Board', (0, 0.45, 0.2), 7.6, 0.3, wood, dio, rot=(math.pi / 2, 0, 0), verts=64)
    board.scale = (1, 0.36, 1)
    cylinder(name + 'BoardRim', (0, 0.28, 0.2), 7.0, 0.06, grad_mat(name + 'Wood2', (0.62, 0.37, 0.18), (0.8, 0.55, 0.32), axis=1, rough=0.6),
             dio, rot=(math.pi / 2, 0, 0), verts=64).scale = (1, 0.33, 1)
    cro = croissant(name + 'Croissant', (0, 0.0, 0.0), 3.3, dio, depth=0.13)
    st = None
    if steam:
        st = steam_wisp(name + 'Steam', (0.2, 0.0, 1.0), height=1.75, parent=cro['root'])
    # caption (hidden until monitor_caption)
    cm = mat(name + 'CapM', (1.0, 0.96, 0.86), emit=(1.0, 0.95, 0.85), strength=1.0 * glow, alpha=0.0)
    cs = mat(name + 'CapShadow', (0.42, 0.2, 0.1), rough=0.8, alpha=0.0)
    cap = empty(name + 'Caption', (-min(ui_x, pw / 2 - 1.2), gy - 1.55, -ph / 2 + 2.0), root)
    text(name + 'CapText', caption, (0, -0.02, 0), 1.25, cm, cap, font='Montserrat-Bold.ttf', extrude=0.01, align='LEFT')
    text(name + 'CapShade', caption, (0.07, 0.01, -0.07), 1.25, cs, cap, font='Montserrat-Bold.ttf', extrude=0.01, align='LEFT')
    slots = [empty(name + 'Slot%d' % i, (0, gy - d, 0), root) for i, d in enumerate((0.4, 0.6, 0.8, 1.0))]
    return {'root': root, 'pw': pw, 'ph': ph, 'border': b, 'chin': chin, 'glass_y': loc[1] + gy, 'front_y': loc[1] - 0.4,
            'center': tuple(loc), 'diorama': dio, 'croissant': cro, 'steam': st, 'board': board, 'caption': cap,
            'caption_mat': (cm, cs), 'files': fobs, 'playhead': play, 'slots': slots, 'plate': plate}


def monitor_file(mon, f, idx):
    """Show file name idx (0 FINAL, 1 FINAL_v2, 2 FINAL_final_v412) from frame f."""
    for i, t in enumerate(mon['files']):
        show(t, f, i == idx)


def monitor_caption(mon, f, dur=8, on=True):
    """Fade the caption in (or out) over dur frames."""
    for mm, a in zip(mon['caption_mat'], (1.0, 0.55)):
        key_alpha(mm, f, 0.0 if on else a)
        key_alpha(mm, f + dur, a if on else 0.0)


def monitor_play(mon, f0, f1, frac0=0.0, frac1=0.3):
    """Slide the playhead along the timeline bar between two fractions."""
    pw = mon['pw']
    x0 = -(pw - 1.2) / 2 + 2.0
    span = (pw - 1.2) - 2.0
    p = mon['playhead']
    key(p, 'location', f0, (x0 + span * frac0, p.location.y, p.location.z), 'linear')
    key(p, 'location', f1, (x0 + span * frac1, p.location.y, p.location.z), 'linear')


# --- the junk: WordArt, sprouting hands, fire


def _rainbow(i, n):
    import colorsys
    h = 0.0 + 0.78 * (i / max(1, n - 1))
    return colorsys.hsv_to_rgb(h, 0.9, 1.0)


def wordart(name, word='POP!', parent=None, loc=(0, 0, 0), size=3.0, arch=0.7, land=None, font='Anton-Regular.ttf'):
    """Arched, extruded WordArt: one colour per letter from red to violet, a white outline, a hard drop-shadow plate
    and a fake perspective tilt. Faces -Y. land=f pops it in with a bounce. Returns a dict: root, letters."""
    root = empty(name, loc, parent)
    root.rotation_euler = (math.pi / 2 - 0.16, 0.0, 0.1)
    inner = empty(name + 'Arch', (0, 0, 0), root)
    idx = [i for i, ch in enumerate(word) if ch.strip()]
    meas = text_widths([word] + [word[:i + 1] for i in idx] + [word[i] for i in idx], size, font)
    total, n = meas[0], len(idx)
    R = total / max(0.2, arch * 2)
    white = mat(name + 'Outline', (1, 1, 1), rough=0.3, emit=(1, 1, 1), strength=0.4)
    shade = mat(name + 'Shadow', (0.12, 0.04, 0.2), rough=0.6)
    letters = []
    for j, i in enumerate(idx):
        wch = meas[1 + n + j]
        xc = -total / 2 + meas[1 + j] - wch / 2
        th = xc / R
        lroot = empty(name + 'L%d' % j, (R * math.sin(th), R * math.cos(th) - R, 0), inner)
        lroot.rotation_euler = (0, 0, -th)
        col = _rainbow(j, n)
        lm = grad_mat(name + 'C%d' % j, tuple(c * 0.55 for c in col), col, axis=1, rough=0.25, coat=0.8)
        t = text(name + 'T%d' % j, word[i], (0, 0, 0), size, lm, lroot, font=font, extrude=size * 0.06, rot=(0, 0, 0))
        t.data.align_y = 'CENTER'
        o = text(name + 'O%d' % j, word[i], (0, 0, -size * 0.07), size, white, lroot, font=font, extrude=size * 0.02, rot=(0, 0, 0))
        o.data.offset = size * 0.035
        s = text(name + 'S%d' % j, word[i], (size * 0.07, -size * 0.07, -size * 0.12), size, shade, lroot, font=font, extrude=size * 0.02, rot=(0, 0, 0))
        s.data.offset = size * 0.035
        letters.append(lroot)
    if land is not None:
        pop_in(root, land, 7)
    return {'root': root, 'letters': letters}


def sprout_hands(name, croissant, sprout=None, wave=None, color=(0.78, 0.4, 0.1)):
    """Two stubby cartoon hands in croissant dough on wobbly forearms, rising from the croissant's flanks.
    The left hand has 5 fingers, the right 6, spread wide so the sixth is easy to count. sprout=f grows them
    (scale 0 -> 1 with overshoot); wave=(start, end) waves them. Returns a dict: L and R, each with root (on the
    croissant's anchor), elbow, hand and fingers (pivots: rotate x to curl)."""
    dough = grad_mat(name + 'Dough', (0.93, 0.64, 0.32), color, axis=2, rough=0.4, coat=0.4, sss=0.06)
    out = {}
    for side, anc, nf, s in (('L', croissant['anchors'][0], 5, -1), ('R', croissant['anchors'][1], 6, 1)):
        root = empty(name + side, (0, 0, 0), anc)
        root.rotation_euler = (0, s * 0.35, 0)
        sphere(name + 'Fore' + side, (0, 0, 0.32), (0.13, 0.11, 0.34), dough, root, seg=24)
        elbow = empty(name + 'Elbow' + side, (0, 0, 0.6), root)
        sphere(name + 'Upper' + side, (0, 0, 0.26), (0.12, 0.1, 0.3), dough, elbow, seg=24)
        hand = empty(name + 'Hand' + side, (0, 0, 0.58), elbow)
        sphere(name + 'Palm' + side, (0, 0, 0.12), (0.3, 0.12, 0.27), dough, hand, seg=32)
        fingers = []
        spread = 1.9 if nf == 6 else 1.6
        for k in range(nf):
            a = -spread / 2 + spread * k / (nf - 1)
            piv = empty(name + 'F%s%d' % (side, k), (0.27 * math.sin(a), 0, 0.12 + 0.24 * math.cos(a)), hand)
            piv.rotation_euler = (0, a, 0)
            ln = 0.2 if k in (0, nf - 1) else 0.26
            sphere(name + 'Fing%s%d' % (side, k), (0, 0, ln * 0.8), (0.068, 0.068, ln), dough, piv, seg=20)
            fingers.append(piv)
        out[side] = {'root': root, 'elbow': elbow, 'hand': hand, 'fingers': fingers}
        if sprout is not None:
            pop_in(root, sprout + (0 if side == 'L' else 2), 8, over=1.25)
        if wave:
            f, i = wave[0], 0
            while f <= wave[1]:
                ph = 1 if (i % 2) else -1
                key(elbow, 'rotation_euler', f, (0, s * 0.15 + ph * 0.3, 0))
                key(hand, 'rotation_euler', f + 1, (0, -ph * 0.25, 0))
                for k, fp in enumerate(fingers):
                    key(fp, 'rotation_euler', f + 1, (ph * 0.15 * ((k % 2) * 2 - 1), fp.rotation_euler[1], 0))
                f += 6
                i += 1
    return out


def _flame_pts(w, h, lean=0.22, n=40):
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x = w * math.sin(t) * abs(math.sin(t / 2)) ** 1.8
        z = h * math.cos(t)
        if z > 0:
            x += lean * h * (z / h) ** 2
        pts.append((x, z))
    return pts


def fire_icon(name, loc=(0, 0, 0), size=1.0, parent=None, glow=0.7):
    """A generic flame icon: three nested extruded teardrops (red, orange, yellow), emissive. About size*2 tall,
    faces -Y. Returns its root."""
    root = empty(name, loc, parent)
    root.scale = (size, size, size)
    for i, (w, h, dz, col) in enumerate([(0.78, 1.0, 0.0, (0.95, 0.07, 0.02)), (0.55, 0.7, -0.26, (1.0, 0.38, 0.0)), (0.33, 0.43, -0.48, (1.0, 0.82, 0.08))]):
        m = mat(name + 'M%d' % i, col, rough=0.45, coat=0.2, emit=col, strength=glow * (0.15 + 0.4 * i))
        _shape_mesh(name + 'Drop%d' % i, _flame_pts(w, h, 0.22 - i * 0.04), 0.15, m, root, loc=(0, -0.07 * i, dz), bevel=0.035)
    return root


def fire_rain(name, count=24, area=(-9, 9, -6, 2), start=1, parent=None, loc=(0, 0, 0), size=1.3, fall=5.0, seed=None):
    """count flame icons that fall in from above, spin a little and settle into a pile inside area (x0, x1, z0, z1)
    of the parent's space (the pile builds up from z0). One layer (the returned root) for a later chip-off."""
    r = _rng(seed or name)
    root = empty(name, loc, parent)
    x0, x1, z0, z1 = area
    cols = max(3, int((x1 - x0) / (size * 1.5)))
    for i in range(count):
        row, col = divmod(i, cols)
        x = x0 + (col + 0.5 + r.uniform(-0.35, 0.35) + (0.5 if row % 2 else 0)) * (x1 - x0) / (cols + 0.5)
        z = min(z1, z0 + row * size * 1.25 + r.uniform(-0.3, 0.4) * size)
        s = size * r.uniform(0.8, 1.15)
        ic = fire_icon(name + '%02d' % i, (x, -0.03 * (i % 7), z), s, root)
        f0 = start + int(i * 0.9 + r.uniform(0, 3))
        f1 = f0 + r.randint(7, 10)
        ry = r.uniform(-0.35, 0.35)
        key(ic, 'location', f0 - 1, (x + r.uniform(-1, 1), ic.location.y, z1 + fall + r.uniform(0, 3)), 'const')
        key(ic, 'location', f0, (x + r.uniform(-1, 1), ic.location.y, z1 + fall + r.uniform(0, 3)))
        key(ic, 'location', f1, (x, ic.location.y, z))
        key(ic, 'location', f1 + 2, (x, ic.location.y, z + 0.25 * size))
        key(ic, 'location', f1 + 4, (x, ic.location.y, z))
        key(ic, 'rotation_euler', f0, (0, ry * 3, 0))
        key(ic, 'rotation_euler', f1 + 4, (0, ry, 0))
        key(ic, 'scale', f0 - 1, (0, 0, 0), 'const')
        key(ic, 'scale', f0, (s, s, s))
    return root


# --- chisel: marble break-off and dust


def shatter(layer_root, frame, pieces=8, seed=None, power=1.0):
    """Break a cut-out layer off like marble at frame: the layer (everything under layer_root, as it is at frame) is
    split into a jittered grid of tiles that crack, pop out towards the camera, tumble and fall, shrinking to nothing
    over 10 frames. The original layer hides at frame. Returns the tile objects."""
    r = _rng(seed or layer_root.name)
    sc = bpy.context.scene
    keep = sc.frame_current
    sc.frame_set(frame)
    dg = bpy.context.evaluated_depsgraph_get()
    srcs = []
    for ob in _descend(layer_root):
        if ob.type not in ('MESH', 'FONT', 'CURVE') or ob.hide_render:
            continue
        ev = ob.evaluated_get(dg)
        if ev.matrix_world.to_scale().length < 1e-4:
            continue
        me = bpy.data.meshes.new_from_object(ev)
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.transform(ev.matrix_world)
        mats = [s.material for s in ob.material_slots] or [None]
        srcs.append((ob, bm, mats))
        bpy.data.meshes.remove(me)
    if not srcs:
        sc.frame_set(keep)
        return []
    xs = [v.co.x for _, bm, _ in srcs for v in bm.verts]
    zs = [v.co.z for _, bm, _ in srcs for v in bm.verts]
    ys = [v.co.y for _, bm, _ in srcs for v in bm.verts]
    bx0, bx1, bz0, bz1 = min(xs), max(xs), min(zs), max(zs)
    cy = sum(ys) / len(ys)
    w, h = max(1e-3, bx1 - bx0), max(1e-3, bz1 - bz0)
    nx = max(1, round(math.sqrt(pieces * w / h)))
    nz = max(1, math.ceil(pieces / nx))
    cx, cz = (bx0 + bx1) / 2, (bz0 + bz1) / 2
    diag = math.hypot(w, h)

    def cuts(a, b, n, axis):
        out = []
        for i in range(1, n):
            co = a + (b - a) * (i + r.uniform(-0.25, 0.25)) / n
            ang = r.uniform(-0.3, 0.3)
            no = Vector((math.cos(ang), 0, math.sin(ang))) if axis == 'x' else Vector((math.sin(ang), 0, math.cos(ang)))
            out.append((Vector((co, cy, cz)) if axis == 'x' else Vector((cx, cy, co)), no))
        return out
    xc, zc = cuts(bx0, bx1, nx, 'x'), cuts(bz0, bz1, nz, 'z')
    allmats = []
    for _, _, mats in srcs:
        for mm in mats:
            if mm not in allmats:
                allmats.append(mm)
    tiles = []
    for ix in range(nx):
        for iz in range(nz):
            cell = bmesh.new()
            for ob, bm, mats in srcs:
                b2 = bm.copy()
                planes = []
                if ix > 0:
                    planes.append((xc[ix - 1][0], -xc[ix - 1][1]))
                if ix < nx - 1:
                    planes.append(xc[ix])
                if iz > 0:
                    planes.append((zc[iz - 1][0], -zc[iz - 1][1]))
                if iz < nz - 1:
                    planes.append(zc[iz])
                for co, no in planes:
                    geom = b2.verts[:] + b2.edges[:] + b2.faces[:]
                    bmesh.ops.bisect_plane(b2, geom=geom, plane_co=co, plane_no=no, clear_outer=True)
                vmap = {}
                for v in b2.verts:
                    vmap[v] = cell.verts.new(v.co)
                for fc in b2.faces:
                    try:
                        nf = cell.faces.new([vmap[v] for v in fc.verts])
                    except ValueError:
                        continue
                    nf.material_index = allmats.index(mats[min(fc.material_index, len(mats) - 1)])
                    nf.smooth = fc.smooth
                b2.free()
            bmesh.ops.remove_doubles(cell, verts=cell.verts[:], dist=1e-5)
            bmesh.ops.dissolve_degenerate(cell, edges=cell.edges[:], dist=1e-5)
            loose = [v for v in cell.verts if not v.link_faces]
            bmesh.ops.delete(cell, geom=loose, context='VERTS')
            if len(cell.faces) < 2:
                cell.free()
                continue
            c = sum((v.co for v in cell.verts), Vector()) / len(cell.verts)
            for v in cell.verts:
                v.co -= c
            me = bpy.data.meshes.new(layer_root.name + 'Tile%d_%d' % (ix, iz))
            cell.to_mesh(me)
            cell.free()
            for mm in allmats:
                me.materials.append(mm)
            t = link(bpy.data.objects.new(me.name, me))
            t.location = c
            tiles.append(t)
    for _, bm, _ in srcs:
        bm.free()
    for ob, _, _ in srcs:
        if not any(fc.data_path == 'hide_render' for fc in _fcurves(ob)):
            show(ob, 0, True, tree=False)
        show(ob, frame, False, tree=False)
    for t in tiles:
        c = t.location.copy()
        out = Vector((c.x - cx, 0, c.z - cz))
        out = out.normalized() if out.length > 1e-4 else Vector((r.uniform(-1, 1), 0, 1)).normalized()
        sp = diag * 0.035 * power * r.uniform(0.7, 1.3)
        v = Vector((out.x * sp, -diag * 0.03 * power * r.uniform(0.6, 1.4), out.z * sp + diag * 0.018 * power))
        g = diag * 0.01 * power
        show(t, 0, False, tree=False)
        show(t, frame, True, tree=False)
        key(t, 'location', frame, tuple(c), 'linear')
        key(t, 'location', frame + 2, tuple(c + out * diag * 0.006), 'linear')
        spin = Vector((r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-1, 1))) * 0.25 * power
        for k in range(2, 13, 2):
            tt = k - 2
            p = c + out * diag * 0.006 + v * tt + Vector((0, 0, -0.5 * g * tt * tt))
            key(t, 'location', frame + k, tuple(p), 'linear')
            key(t, 'rotation_euler', frame + k, tuple(spin * tt), 'linear')
        key(t, 'scale', frame + 2, (1, 1, 1))
        key(t, 'scale', frame + 12, (0, 0, 0))
    sc.frame_set(keep)
    return tiles


def _ico(name, loc, radius, m, parent=None, subd=1):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subd, radius=radius)
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    me.materials.append(m)
    if parent:
        ob.parent = parent
    ob.location = loc
    return ob


def dust_burst(name, loc, frame, size=1.0, parent=None, chips=40, toward=(0, -1, 0.4), seed=None):
    """A marble break: chips (white stone with faint grey veins) fly out on ballistic arcs and a puff of soft white
    dust grows x3 and fades over 12 frames. Nothing shows before frame. Returns the root."""
    r = _rng(seed or name)
    root = empty(name, loc, parent)
    stone = marble_mat(name + 'Stone', rough=0.5)
    tw = Vector(toward)
    for i in range(chips):
        ch = _ico(name + 'Chip%02d' % i, (0, 0, 0), size * r.uniform(0.05, 0.13), stone, root, subd=1)
        sc0 = (1, r.uniform(0.6, 1.0), r.uniform(0.5, 1.0))
        d = Vector((r.uniform(-1, 1), r.uniform(-0.3, 0.3), r.uniform(-0.4, 1))).normalized() + tw * 0.6
        sp = size * r.uniform(0.12, 0.3)
        g = size * 0.035
        key(ch, 'scale', frame - 1, (0, 0, 0), 'const')
        key(ch, 'scale', frame, sc0, 'const')
        for k in range(0, 17, 2):
            p = d * sp * k + Vector((0, 0, -0.5 * g * k * k))
            key(ch, 'location', frame + k, tuple(p), 'linear')
            key(ch, 'rotation_euler', frame + k, (k * 0.3 * d.x, k * 0.25, k * 0.2 * d.z), 'linear')
        key(ch, 'scale', frame + 10, sc0)
        key(ch, 'scale', frame + 17, (0, 0, 0))
    puff = soft_mat(name + 'Puff', (1.0, 0.99, 0.97), 0.25, 0.3)
    key_alpha(puff, frame, 0.28)
    key_alpha(puff, frame + 4, 0.16)
    key_alpha(puff, frame + 12, 0.0)
    for i in range(8):
        a = i / 8 * 2 * math.pi
        p0 = Vector((math.cos(a) * 0.15, r.uniform(-0.2, 0.1), math.sin(a) * 0.12)) * size
        s = sphere(name + 'Puff%d' % i, tuple(p0), (0, 0, 0), puff, root, seg=16)
        s.visible_shadow = False
        r0 = size * r.uniform(0.16, 0.24)
        key(s, 'scale', frame - 1, (0, 0, 0), 'const')
        key(s, 'scale', frame, (r0, r0, r0))
        key(s, 'scale', frame + 12, (r0 * 3, r0 * 3, r0 * 3))
        key(s, 'location', frame + 12, tuple(p0 * 4.0 + Vector((0, -0.2, 0.3)) * size))
        key(s, 'scale', frame + 13, (0, 0, 0), 'const')
    return root


def dust_drift(name, src, dst, f0, f1, count=20, size=1.0, parent=None, seed=None):
    """About 20 slow marble motes drift from src to dst between f0 and f1 on lazy curves and settle there
    (scattered over size around dst). Hidden before f0. Returns the root."""
    r = _rng(seed or name)
    root = empty(name, (0, 0, 0), parent)
    stone = marble_mat(name + 'Stone', rough=0.5)
    a, b = Vector(src), Vector(dst)
    for i in range(count):
        p0 = a + Vector((r.uniform(-1, 1), r.uniform(-0.5, 0.5), r.uniform(-0.6, 0.6))) * size * 0.8
        p1 = b + Vector((r.uniform(-1, 1), r.uniform(-0.1, 0.1), r.uniform(-0.15, 0.15))) * size * 0.5
        mo = _ico(name + 'Mote%02d' % i, tuple(p0), size * r.uniform(0.025, 0.05), stone, root, subd=1)
        st = f0 + r.randint(0, max(1, (f1 - f0) // 4))
        en = f1 - r.randint(0, max(1, (f1 - f0) // 6))
        key(mo, 'scale', st - 1, (0, 0, 0), 'const')
        key(mo, 'scale', st, (1, 1, 1))
        ph = r.uniform(0, 6.28)
        n = 5
        for k in range(n + 1):
            u = k / n
            e = u * u * (3 - 2 * u)
            p = p0.lerp(p1, e) + Vector((0.15 * math.sin(ph + u * 5), 0, 0.25 * math.sin(u * math.pi))) * size * (1 - u)
            key(mo, 'location', int(st + (en - st) * u), tuple(p))
    return root


# --- the desk extras: the David postcard, the cup's label, the marker and the tally


def _corner_cut(w, h, e, x0=0.0, z0=0.0):
    """A w x h rectangle (bottom-left at x0, z0) with its top-right corner cut by a 45 degree line e from the corner."""
    return [(x0, z0), (x0 + w, z0), (x0 + w, z0 + h - e), (x0 + w - e, z0 + h), (x0, z0 + h)]


def david_postcard(name, loc, rot=(0, 0, 0), w=2.6, h=3.8, quote='"I just removed everything that wasn\'t David."',
                   credit='—Michelangelo', ear=0.42):
    """A dog-eared museum postcard standing on its bottom edge (root at the bottom centre, face to -Y; tilt it back
    with rot). The upper part is a warm sepia ground with a stylised low-relief bust of the public-domain David
    (procedural, not traced from any photograph); the bottom strip carries the quote in small caps (Inter-Regular,
    0.19) over a few lines and the credit. Returns its root."""
    root = empty(name, loc)
    root.rotation_euler = rot
    card = mat(name + 'Card', (0.95, 0.91, 0.82), rough=0.85, sheen=0.3)
    back = mat(name + 'CardBack', (0.86, 0.82, 0.74), rough=0.9)
    _shape_mesh(name + 'Stock', _corner_cut(w, h, ear, -w / 2, 0), 0.03, card, root, bevel=0.012)
    # dog-ear: the corner folded forward, and a soft crease shadow under it
    fx, fz = w / 2 - ear, h - ear
    _shape_mesh(name + 'Flap', [(fx, h), (w / 2, fz), (fx + 0.01, fz + 0.01)], 0.008, back, root, loc=(0, -0.022, 0))
    sh = mat(name + 'Crease', (0.25, 0.18, 0.12), rough=1.0, alpha=0.35)
    _shape_mesh(name + 'CreaseShadow', [(fx - 0.05, h - 0.02), (w / 2 - 0.02, fz - 0.05), (fx - 0.04, fz - 0.06)], 0.004, sh, root, loc=(0, -0.006, 0))
    # sepia panel (its corner cut on the same fold line)
    m = 0.13
    pz0 = h * 0.29
    pw_, ph_ = w - 2 * m, h - m - pz0
    sep = grad_mat(name + 'Sepia', (0.16, 0.085, 0.04), (0.42, 0.27, 0.14), axis=2, rough=0.9, mid=(0.6, (0.3, 0.18, 0.09)))
    _shape_mesh(name + 'Panel', _corner_cut(pw_, ph_, max(0.01, ear - m * 1.41), -pw_ / 2, pz0), 0.005, sep, root, loc=(0, -0.006, 0))
    # the bust, in low relief (thin in y), centred in the panel
    stone = marble_mat(name + 'Marble', (0.86, 0.83, 0.77), (0.66, 0.63, 0.58), rough=0.45, sss=0.2)
    k = min(pw_ / 2.34, ph_ / 2.57)
    bust = empty(name + 'Bust', (0.0, -0.012, pz0), root)
    bust.scale = (k, k * 1.4, k)

    def blob(n, x, z, sx, sz, d=0.06, ry=0.0):
        o = sphere(name + n, (x, 0, z), (sx, d, sz), stone, bust, seg=24)
        o.rotation_euler = (0, ry, 0)
        return o
    blob('ShoulderL', -0.72, 0.18, 0.5, 0.26, 0.05, -0.25)
    blob('ShoulderR', 0.7, 0.2, 0.48, 0.25, 0.05, 0.3)
    blob('Chest', 0.0, 0.12, 0.62, 0.22, 0.06)
    blob('Neck', 0.04, 0.72, 0.22, 0.48, 0.07, 0.1)
    blob('Ridge', 0.12, 0.66, 0.05, 0.36, 0.085, -0.45)
    blob('Ridge2', -0.1, 0.64, 0.04, 0.3, 0.08, 0.35)
    blob('Head', -0.04, 1.48, 0.38, 0.52, 0.09, 0.12)
    blob('Jaw', -0.14, 1.16, 0.26, 0.2, 0.085, 0.3)
    blob('Brow', -0.24, 1.62, 0.2, 0.06, 0.12, -0.15)
    nose = blob('Nose', -0.36, 1.46, 0.07, 0.15, 0.13, -0.25)
    blob('Lips', -0.32, 1.24, 0.07, 0.035, 0.11)
    blob('Ear', 0.17, 1.44, 0.07, 0.12, 0.1)
    eye = mat(name + 'EyeShade', (0.55, 0.5, 0.44), rough=0.8)
    sphere(name + 'Eye', (-0.22, -0.11, 1.52), (0.06, 0.02, 0.03), eye, bust, seg=16)
    for i in range(14):
        a = math.radians(-20 + i * 14.5)
        rr = 0.42 + 0.05 * ((i * 7) % 3)
        x, z = -0.04 + rr * math.cos(a) * 0.95, 1.52 + rr * math.sin(a) * 0.95
        sphere(name + 'Curl%d' % i, (x, 0, z), (0.12, 0.1, 0.12), stone, bust, seg=16)
    # the quote, museum style
    ink = mat(name + 'Ink', (0.2, 0.16, 0.13), rough=0.7)
    size = 0.19
    lines = wrap(quote, size, w - 0.3, 'Inter-Regular.ttf', smallcaps=True)
    lines.append(credit)
    lead = size * 1.12
    top = pz0 - 0.12 - size * 0.5
    for i, ln in enumerate(lines):
        t = text(name + 'Q%d' % i, ln, (0, -0.012, top - i * lead), size, ink, root, font='Inter-Regular.ttf', extrude=0.002)
        small_caps(t.data)
        if i == len(lines) - 1:
            t.location.x = w / 2 - 0.16
            t.data.align_x = 'RIGHT'
    return root


_mk_text = text


def label_tape(name, text='MICHELANGELO', cup=None, angle=0.0, r=1.55, z=1.6, size=0.3, tilt=3.0):
    """An embossed label-maker strip wrapped round a cup of radius r (the kit pencil_cup is 1.55): glossy dark red
    plastic, raised white letters, notched ends, slightly crooked (tilt degrees). angle=0 faces -Y. Parent: cup.
    Returns its root."""
    root = empty(name, (0, 0, 0), cup)
    red = mat(name + 'Plastic', (0.42, 0.02, 0.03), rough=0.25, coat=1.0)
    white = mat(name + 'Emboss', (0.97, 0.96, 0.93), rough=0.35, coat=0.6)
    font = 'Montserrat-Bold.ttf'
    idx = [i for i, ch in enumerate(text) if ch.strip()]
    meas = text_widths([text] + [text[:i + 1] for i in idx] + [text[i] for i in idx], size, font)
    total, n = meas[0], len(idx)
    L = total + size * 1.4
    hh = size * 0.78
    tt = math.tan(math.radians(tilt))
    ph0 = -math.pi / 2 + angle
    R = r + 0.015
    me = bpy.data.meshes.new(name + 'Strip')
    bm = bmesh.new()
    cols = 40
    rows = []
    for c in range(cols + 1):
        s = -L / 2 + L * c / cols
        ph = ph0 + s / R
        notch = size * 0.22 if c in (0, cols) else 0.0
        ss = s + (notch if c == 0 else -notch)
        col = []
        for dz in (-hh / 2, 0.0, hh / 2):
            sp = ss if dz == 0.0 else s
            ph2 = ph0 + sp / R
            col.append(bm.verts.new((R * math.cos(ph2), R * math.sin(ph2), z + s * tt + dz)))
        rows.append(col)
    for c in range(cols):
        for j in range(2):
            bm.faces.new((rows[c][j], rows[c + 1][j], rows[c + 1][j + 1], rows[c][j + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    strip = link(bpy.data.objects.new(name + 'Strip', me))
    strip.parent = root
    for p in me.polygons:
        p.use_smooth = True
    sol = strip.modifiers.new('solid', 'SOLIDIFY')
    sol.thickness = 0.03
    sol.offset = 1.0
    me.materials.append(red)
    rg = _rng(name)
    for j, i in enumerate(idx):
        wch = meas[1 + n + j]
        s = -total / 2 + meas[1 + j] - wch / 2
        ph = ph0 + s / R
        rr = R + 0.035
        _mk_text(name + 'L%d' % j, text[i], (rr * math.cos(ph), rr * math.sin(ph), z + s * tt + rg.uniform(-0.012, 0.012)),
                 size, white, root, font=font, extrude=0.01, rot=(math.pi / 2, math.atan(tt) + rg.uniform(-0.03, 0.03), ph + math.pi / 2))
    return root


def marker(name, loc, length=3.2, radius=0.28, rot=(0, 0, 0), color=(0.03, 0.03, 0.035)):
    """A chunky felt marker standing on its end (longer than the robot): black barrel, white label band, a cap with a
    clip that comes off (animate 'cap'), a felt tip under it. Returns a dict: root (at the bottom end), cap, tip,
    grip (an empty mid-barrel; use grab(mk['root'], c.handR, f) to put it in a hand)."""
    root = empty(name, loc)
    root.rotation_euler = rot
    barrel = mat(name + 'Barrel', color, rough=0.35, coat=0.6)
    lab = mat(name + 'Label', (0.95, 0.94, 0.9), rough=0.5)
    L = length
    cylinder(name + 'Barrel', (0, 0, L * 0.36), radius, L * 0.72, barrel, root, verts=32)
    cylinder(name + 'Band', (0, 0, L * 0.36), radius * 1.03, L * 0.22, lab, root, verts=32)
    rbox(name + 'BandStripe', (0, -radius * 1.04, L * 0.36), (radius * 0.9, 0.02, L * 0.05), 0.01, mat(name + 'Stripe', (0.85, 0.15, 0.1), rough=0.5), root, segs=2)
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=radius * 0.62, radius2=radius * 0.12, depth=L * 0.12, location=(0, 0, 0))
    tip = bpy.context.active_object
    _finish(tip, name + 'Tip', root)
    tip.location = (0, 0, L * 0.72 + L * 0.06)
    assign(tip, mat(name + 'Felt', (0.02, 0.02, 0.02), rough=0.9))
    cap = empty(name + 'Cap', (0, 0, L * 0.68), root)
    cylinder(name + 'CapBody', (0, 0, L * 0.16), radius * 1.08, L * 0.32, barrel, cap, verts=32)
    sphere(name + 'CapTop', (0, 0, L * 0.32), (radius * 1.0, radius * 1.0, radius * 0.4), barrel, cap, seg=24)
    rbox(name + 'Clip', (radius * 1.12, 0, L * 0.18), (0.08, radius * 0.6, L * 0.26), 0.035, barrel, cap, segs=2)
    grip = empty(name + 'Grip', (0, 0, L * 0.36), root)
    return {'root': root, 'cap': cap, 'tip': tip, 'grip': grip}


_UVS = None


def _unit_sphere(u=10, v=6):
    """Vertices and faces of a small unit UV sphere (cached)."""
    global _UVS
    if _UVS is None:
        vs = [(0.0, 0.0, 1.0)]
        for i in range(1, v):
            th = math.pi * i / v
            for j in range(u):
                ph = 2 * math.pi * j / u
                vs.append((math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)))
        vs.append((0.0, 0.0, -1.0))
        fs = []
        for j in range(u):
            fs.append((0, 1 + j, 1 + (j + 1) % u))
        for i in range(v - 2):
            for j in range(u):
                a0 = 1 + i * u
                fs.append((a0 + j, a0 + u + j, a0 + u + (j + 1) % u, a0 + (j + 1) % u))
        last = len(vs) - 1
        base = 1 + (v - 2) * u
        for j in range(u):
            fs.append((base + j, last, base + (j + 1) % u))
        _UVS = (vs, fs)
    return _UVS


def _stroke(acc, x, z, ln, wd, ang, y, r):
    """One marker stroke (appended to acc = (verts, faces)): two overlapping thin ellipsoids, slightly bent."""
    uv, uf = _unit_sphere()
    bend = r.uniform(-0.12, 0.12)
    for half in (-1, 1):
        a = ang + half * bend
        cx = x - half * ln * 0.22 * math.sin(ang)
        cz = z + half * ln * 0.22 * math.cos(ang)
        mtx = Matrix.Translation((cx, y, cz)) @ Matrix.Rotation(-a, 4, 'Y') @ Matrix.Diagonal((wd / 2, 0.02, ln * 0.3, 1))
        n0 = len(acc[0])
        acc[0].extend(tuple(mtx @ Vector(p)) for p in uv)
        acc[1].extend(tuple(n0 + i for i in f) for f in uf)


def bezel_tally(name, mon, groups=120, live_frame=None, again_frame=None, seed=None, label='HUMAN WAS RIGHT', again='(again)'):
    """Off-white marker tallies (groups of four and a slash) all round a video_monitor's bezel and chin, densest at
    the lower left, under a hand-lettered label on the chin. live_frame draws one more slash on (8 frames);
    again_frame writes '(again)' above the label letter by letter. Returns a dict: root, strokes, label, again
    (letters), live (the live stroke's pivot)."""
    r = _rng(seed or name)
    root = empty(name, (0, 0, 0), mon['root'])
    pw, ph, b, chin = mon['pw'], mon['ph'], mon['border'], mon['chin']
    W = pw + 2 * b
    y = -0.43
    paint = mat(name + 'Paint', (0.93, 0.92, 0.85), rough=0.6, emit=(0.93, 0.92, 0.85), strength=0.15)
    zl = -ph / 2 - b - chin + 0.85          # label baseline row on the chin
    lab_root, lab_letters, lab_w = hand_text(name + 'Label', label, (-W / 2 + 0.75, y - 0.01, zl), 0.6, paint, root,
                                             jit_rot=0.07, jit_off=0.04, align='LEFT')
    ag_root, ag_letters, ag_w = hand_text(name + 'Again', again, (-W / 2 + 0.9, y - 0.01, zl + 0.78), 0.4, paint, root,
                                          jit_rot=0.14, jit_off=0.07, align='LEFT')
    if again_frame is not None:
        for i, l in enumerate(ag_letters):
            pop_in(l, again_frame + i * 2, 3, over=1.1)
    # candidate group slots: top border, both sides, chin rows (skipping the label corner)
    slots = []
    gw = 1.15
    zt = ph / 2 + b / 2 + 0.05
    x = -W / 2 + 0.75
    while x < W / 2 - 0.75:
        slots.append((x, zt, 0.0, min(0.9, b - 0.55)))
        x += gw
    z = ph / 2 - 0.3
    while z > -ph / 2 - 0.2:
        for sx in (-1, 1):
            slots.append((sx * (pw / 2 + b / 2 + 0.06), z, math.pi / 2, min(0.9, b - 0.55)))
        z -= gw
    zc0 = -ph / 2 - 0.85
    rows = [zc0 - k * 1.05 for k in range(int((b + chin - 0.9) / 1.05) + 1)]
    for zr in rows:
        x = -W / 2 + 0.75
        while x < W / 2 - 0.75:
            if not (x < -W / 2 + 0.75 + max(lab_w, ag_w) + 0.6 and zr < zl + 1.25):
                slots.append((x, zr, 0.0, 0.9))
            x += gw
    def weight(s):
        return 1.0 + 3.0 * math.exp(-((s[0] + W / 2) / (W * 0.35)) ** 2 - ((s[1] + ph / 2 + b + chin) / (ph * 0.45)) ** 2)
    slots.sort(key=lambda s: -weight(s) * r.uniform(0.6, 1.0))
    chosen = slots[:groups]
    extra = groups - len(chosen)
    for k in range(max(0, extra)):
        s = slots[k % max(1, len(slots) // 4)]
        chosen.append((s[0] + r.uniform(-0.3, 0.3), s[1] + r.uniform(-0.15, 0.15), s[2] + r.uniform(-0.15, 0.15), s[3]))
    me = bpy.data.meshes.new(name + 'Strokes')
    bm = ([], [])
    live_slot = None
    for gi, (gx, gz, ga, ln) in enumerate(chosen):
        ca, sa = math.cos(ga), math.sin(ga)
        for k in range(4):
            off = (k - 1.5) * 0.19
            px, pz = gx + off * ca + r.uniform(-0.03, 0.03), gz - off * sa + r.uniform(-0.03, 0.03)
            _stroke(bm, px, pz, ln * r.uniform(0.9, 1.05), 0.07, ga + r.uniform(-0.08, 0.08), y, r)
        if gi == 0 and live_frame is not None:
            live_slot = (gx, gz, ga, ln)
            continue
        _stroke(bm, gx, gz, ln * 1.12, 0.07, ga + 1.05 + r.uniform(-0.1, 0.1), y - 0.005, r)
    me.from_pydata(bm[0], [], bm[1])
    strokes = link(bpy.data.objects.new(name + 'Strokes', me))
    strokes.parent = root
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(paint)
    live = None
    if live_slot:
        gx, gz, ga, ln = live_slot
        a = ga + 1.05
        L = ln * 1.12
        live = empty(name + 'Live', (gx + L / 2 * math.sin(a), y - 0.01, gz - L / 2 * math.cos(a)), root)
        live.rotation_euler = (0, -a, 0)
        sphere(name + 'LiveStroke', (0, 0, L / 2), (0.035, 0.02, L / 2), paint, live, seg=16)
        key(live, 'scale', live_frame - 1, (1, 1, 0.0), 'const')
        key(live, 'scale', live_frame, (1, 1, 0.05))
        key(live, 'scale', live_frame + 8, (1, 1, 1.0))
    return {'root': root, 'strokes': strokes, 'label': lab_root, 'again': ag_letters, 'again_root': ag_root, 'live': live}


# --- the phone thread, the vertical outline, the robot's sign, the size cards


def pray_icon(name, loc, size=0.3, parent=None):
    """Folded hands (the fonts have no emoji): two yellow rounded palms touching, with little cuffs. Returns its root."""
    root = empty(name, loc, parent)
    root.scale = (size, size, size)
    y = mat(name + 'Skin', (1.0, 0.78, 0.18), rough=0.4, coat=0.3, emit=(1.0, 0.75, 0.15), strength=0.25)
    cuff = mat(name + 'Cuff', (0.95, 0.55, 0.12), rough=0.5, emit=(0.95, 0.55, 0.12), strength=0.2)
    for s in (-1, 1):
        p = sphere(name + 'Palm%d' % s, (s * 0.17, 0, 0.02), (0.18, 0.1, 0.46), y, root, seg=20)
        p.rotation_euler = (0, -s * 0.22, 0)
        c = sphere(name + 'Cuff%d' % s, (s * 0.27, 0, -0.44), (0.17, 0.11, 0.11), cuff, root, seg=16)
        c.rotation_euler = (0, -s * 0.22, 0)
    sphere(name + 'Thumbs', (0, -0.08, -0.08), (0.1, 0.05, 0.16), y, root, seg=16)
    return root


def thumbs_icon(name, loc, size=0.3, parent=None, m=None):
    """A generic thumbs-up: a rounded fist with the thumb up."""
    root = empty(name, loc, parent)
    root.scale = (size, size, size)
    rbox(name + 'Fist', (0.05, 0, -0.15), (0.75, 0.15, 0.6), 0.2, m, root, segs=3)
    rbox(name + 'Thumb', (-0.12, 0, 0.32), (0.26, 0.15, 0.55), 0.12, m, root, segs=3).rotation_euler = (0, -0.25, 0)
    return root


def _heart_pts(s=1.0, n=36):
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        pts.append((s * 0.06 * 16 * math.sin(t) ** 3, 0, s * 0.06 * (13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t))))
    return pts


def _bubble(name, root, x, z, w, h, col, glow, right):
    m = mat(name + 'M', col, rough=0.5, emit=col, strength=glow)
    bx = x - w / 2 if right else x + w / 2
    rbox(name + 'Box', (bx, 0, z - h / 2), (w, 0.02, h), min(0.18, h / 2 - 0.01), m, root, segs=3)
    return m


def phone_thread(name, loc, lean=0.26, messages=(), rot_z=0.0, contact='Rosie', banner=None, shown=0, glow=1.0, support=True):
    """An upright phone leaning back (lean radians) on a little stand, showing a generic chat thread (neutral dark UI,
    no real messenger look). messages: a list of
        ('in', sender, text[, 'pray'])    light grey bubble on the left with a small sender line
        ('out', text[, 'pray'])           warm coral bubble on the right
        ('video',)                        outgoing video bubble with a tiny croissant picture and a play button
    Text is Inter-Bold 0.30, wrapped to the bubble. Bubbles are hidden until thread_reveal(th, i, f) (the first
    `shown` start visible); the thread scrolls up as it grows. banner=(title, text[, 'pray']) builds a notification
    card at the top, hidden until thread_banner(th, f). A reaction row (heart, thumbs-up, fire) and a send button sit
    at the bottom. Returns a dict: root, bubbles, banner, fire_button, thread, screen."""
    root = empty(name, loc)
    root.rotation_euler = (-lean, 0, rot_z)
    W, H = 2.35, 4.8
    body = mat(name + 'BodyM', (0.06, 0.06, 0.08), rough=0.25, coat=1.0)
    rbox(name + 'Body', (0, 0, H / 2 + 0.02), (W, 0.24, H), 0.32, body, root)
    scr = rbox(name + 'Screen', (0, -0.125, H / 2 + 0.02), (W - 0.17, 0.02, H - 0.2), 0.26,
               mat(name + 'ScreenM', (0.05, 0.05, 0.065), rough=0.2, emit=(0.06, 0.06, 0.08), strength=glow), root, segs=3)
    if support:
        st = mat(name + 'StandM', (0.55, 0.56, 0.6), rough=0.4, metal=0.6)
        rbox(name + 'StandBack', (0, 0.9, 1.3), (1.3, 0.12, 2.6), 0.05, st, root, segs=2).rotation_euler = (0.42, 0, 0)
        rbox(name + 'StandLip', (0, -0.22, 0.12), (1.6, 0.3, 0.24), 0.06, st, root, segs=2)
    yF = -0.15
    sw = W - 0.17
    zt, zb = H - 0.72, 1.32
    # header: avatar disc with an initial and the contact name, over a slightly lighter bar (hides scrolled bubbles)
    head = mat(name + 'HeadM', (0.1, 0.1, 0.12), rough=0.4, emit=(0.1, 0.1, 0.12), strength=glow)
    rbox(name + 'Header', (0, yF - 0.03, H - 0.42 + 0.02), (sw - 0.06, 0.02, 0.62), 0.12, head, root, segs=2)
    rbox(name + 'Footer', (0, yF - 0.03, 0.62), (sw - 0.06, 0.02, 1.3), 0.12, head, root, segs=2)
    white = mat(name + 'White', (1, 1, 1), emit=(1, 1, 1), strength=1.4 * glow)
    grey = mat(name + 'GreyTxt', (0.62, 0.62, 0.66), emit=(0.62, 0.62, 0.66), strength=0.9 * glow)
    av = mat(name + 'Avatar', (0.95, 0.55, 0.35), emit=(0.95, 0.55, 0.35), strength=0.8 * glow)
    cylinder(name + 'Avatar', (-sw / 2 + 0.42, yF - 0.05, H - 0.4), 0.2, 0.02, av, root, rot=(math.pi / 2, 0, 0), verts=24)
    text(name + 'AvatarI', contact[:1], (-sw / 2 + 0.42, yF - 0.07, H - 0.41), 0.24, white, root, font='Inter-Bold.ttf', extrude=0.003)
    text(name + 'Contact', contact, (-sw / 2 + 0.75, yF - 0.07, H - 0.4), 0.26, white, root, font='Inter-Bold.ttf', extrude=0.003, align='LEFT')
    # reaction row and input bar
    pill = mat(name + 'Pill', (0.2, 0.2, 0.23), emit=(0.2, 0.2, 0.23), strength=0.7 * glow)
    rbox(name + 'Input', (-0.2, yF - 0.05, 0.42), (sw - 0.75, 0.02, 0.4), 0.19, pill, root, segs=3)
    coral = mat(name + 'Coral', (1.0, 0.45, 0.32), emit=(1.0, 0.45, 0.32), strength=1.0 * glow)
    cylinder(name + 'Send', (sw / 2 - 0.32, yF - 0.05, 0.42), 0.22, 0.02, coral, root, rot=(math.pi / 2, 0, 0), verts=24)
    _shape_mesh(name + 'SendArrow', [(-0.09, -0.1), (0.12, 0.0), (-0.09, 0.1), (-0.04, 0.0)], 0.01, white, root, loc=(sw / 2 - 0.31, yF - 0.08, 0.42))
    red = mat(name + 'HeartM', (1.0, 0.25, 0.35), emit=(1.0, 0.25, 0.35), strength=1.0 * glow)
    rx = -sw / 2 + 0.35
    for i in range(3):
        cylinder(name + 'React%d' % i, (rx + i * 0.5, yF - 0.05, 0.95), 0.2, 0.02, pill, root, rot=(math.pi / 2, 0, 0), verts=24)
    heart(name + 'ReactHeart', (rx, yF - 0.08, 0.94), 0.17, red, root)
    thumbs_icon(name + 'ReactThumb', (rx + 0.5, yF - 0.08, 0.96), 0.2, root, m=mat(name + 'ThumbM', (1.0, 0.8, 0.25), emit=(1.0, 0.8, 0.25), strength=0.6 * glow))
    fire = fire_icon(name + 'ReactFire', (rx + 1.0, yF - 0.06, 0.95), 0.12, root)
    # the thread
    thread = empty(name + 'Thread', (0, yF - 0.02, 0), root)
    size, maxw = 0.3, sw - 0.45
    gap, pad = 0.14, 0.13
    bubbles, spans = [], []
    z = zt
    inc = mat(name + 'InInk', (0.06, 0.06, 0.08), rough=0.6)
    for i, msg in enumerate(messages):
        kind = msg[0]
        right = kind != 'in'
        br = empty(name + 'Bubble%d' % i, (0, 0, 0), thread)
        if kind == 'video':
            bw, bh = 1.55, 1.0
            x = sw / 2 - 0.12
            br.location = (x, 0, z)
            _bubble(name + 'B%d' % i, br, 0, 0, bw, bh, (1.0, 0.45, 0.32), 0.9 * glow, True)
            pic = rbox(name + 'Pic%d' % i, (-bw / 2, -0.02, -bh / 2), (bw - 0.12, 0.02, bh - 0.12), 0.1,
                       grad_mat(name + 'PicM%d' % i, (0.95, 0.62, 0.42), (1.0, 0.9, 0.75), glow=0.8 * glow), br, segs=2)
            pic.modifiers.remove(pic.modifiers['sub'])
            cro = croissant(name + 'PicCro%d' % i, (-bw / 2, -0.06, -bh / 2 - 0.3), 0.22, br, depth=0.2)
            steam_wisp(name + 'PicSteam%d' % i, (0, 0, 1.0), height=1.6, parent=cro['root'])
            cylinder(name + 'Play%d' % i, (-bw / 2, -0.12, -bh / 2 + 0.05), 0.16, 0.01, mat(name + 'PlayM%d' % i, (0, 0, 0), alpha=0.45), br, rot=(math.pi / 2, 0, 0), verts=24)
            _shape_mesh(name + 'PlayTri%d' % i, [(-0.05, -0.08), (0.09, 0.0), (-0.05, 0.08)], 0.005, white, br, loc=(-bw / 2 + 0.01, -0.14, -bh / 2 + 0.05))
            h_ = bh
        else:
            body_txt = msg[2] if kind == 'in' else msg[1]
            pray = msg[-1] == 'pray' and len(msg) > (3 if kind == 'in' else 2)
            lines = wrap(body_txt, size, maxw - (0.32 if pray else 0), 'Inter-Bold.ttf')
            ws = text_widths(lines, size, 'Inter-Bold.ttf')
            lw = max(ws) + (0.4 if pray and ws[-1] + 0.4 > max(ws) else 0)
            sender = msg[1] if kind == 'in' else None
            sh = 0.24 if sender else 0.0
            if sender:
                lw = max(lw, text_widths([sender], 0.19, 'Inter-Bold.ttf')[0])
            bw = lw + 2 * pad
            h_ = sh + len(lines) * size * 1.22 + 2 * pad - 0.04
            x = sw / 2 - 0.12 if right else -sw / 2 + 0.12
            br.location = (x, 0, z)
            _bubble(name + 'B%d' % i, br, 0, 0, bw, h_, (0.9, 0.3, 0.2) if right else (0.86, 0.86, 0.89), (0.5 if right else 0.55) * glow, right)
            ink = white if right else inc
            tx = -bw + pad if right else pad
            if sender:
                text(name + 'Sender%d' % i, sender, (tx, -0.02, -pad - 0.08), 0.19, mat(name + 'SendM%d' % i, (0.35, 0.35, 0.42), rough=0.6), br, font='Inter-Bold.ttf', extrude=0.002, align='LEFT')
            for k, ln in enumerate(lines):
                text(name + 'Txt%d_%d' % (i, k), ln, (tx, -0.02, -pad - sh - size * 0.5 - k * size * 1.22), size, ink, br, font='Inter-Bold.ttf', extrude=0.003, align='LEFT')
            if pray:
                pray_icon(name + 'Pray%d' % i, (tx + ws[-1] + 0.2, -0.04, -pad - sh - size * 0.5 - (len(lines) - 1) * size * 1.22), 0.26, br)
        spans.append((z, z - h_))
        z -= h_ + gap
        bubbles.append(br)
    th = {'root': root, 'bubbles': bubbles, 'spans': spans, 'thread': thread, 'top': zt, 'bottom': zb, 'screen': scr,
          'fire_button': fire, 'banner': None, 'scroll': 0.0}
    for i, br in enumerate(bubbles):
        if i >= shown:
            br.scale = (0, 0, 0)
            key(br, 'scale', 0, (0, 0, 0), 'const')
    if shown:
        _scroll_to(th, shown - 1, 0, 0)
    if banner:
        bn = empty(name + 'Banner', (0, yF - 0.12, H - 0.9), root)
        card = mat(name + 'BannerM', (0.93, 0.93, 0.95), rough=0.4, emit=(0.93, 0.93, 0.95), strength=0.75 * glow)
        btxt = banner[1]
        bpray = len(banner) > 2 and banner[2] == 'pray'
        lines = wrap(btxt, 0.26, sw - 0.5 - (0.3 if bpray else 0), 'Inter-Bold.ttf')
        bh = 0.36 + len(lines) * 0.32 + 0.22
        rbox(name + 'BannerCard', (0, 0, -bh / 2 + 0.2), (sw - 0.14, 0.03, bh), 0.2, card, bn, segs=3)
        rbox(name + 'BannerIcon', (-sw / 2 + 0.3, -0.03, 0.06), (0.26, 0.02, 0.26), 0.07, coral, bn, segs=2)
        text(name + 'BannerTitle', banner[0], (-sw / 2 + 0.52, -0.03, 0.05), 0.2, inc, bn, font='Inter-Bold.ttf', extrude=0.002, align='LEFT')
        for k, ln in enumerate(lines):
            text(name + 'BannerL%d' % k, ln, (-sw / 2 + 0.2, -0.03, -0.3 - k * 0.32), 0.26, inc, bn, font='Inter-Bold.ttf', extrude=0.002, align='LEFT')
        if bpray:
            wl = text_widths([lines[-1]], 0.26, 'Inter-Bold.ttf')[0]
            pray_icon(name + 'BannerPray', (-sw / 2 + 0.2 + wl + 0.18, -0.05, -0.3 - (len(lines) - 1) * 0.32), 0.24, bn)
        bn.scale = (0, 0, 0)
        key(bn, 'scale', 0, (0, 0, 0), 'const')
        th['banner'] = bn
    return th


def _scroll_to(th, i, f, dur=4):
    top, bottom = th['top'], th['bottom']
    off = max(0.0, bottom - th['spans'][i][1])
    t = th['thread']
    if dur:
        key(t, 'location', f, (0, t.location.y, th['scroll']))
    key(t, 'location', f + dur, (0, t.location.y, off))
    gone = th.setdefault('gone', set())
    for j in range(i):
        if j not in gone and th['spans'][j][0] + off > top + 0.35:
            gone.add(j)
            key(th['bubbles'][j], 'scale', f + dur - 1, (1, 1, 1))
            key(th['bubbles'][j], 'scale', f + dur, (0, 0, 0))
    th['scroll'] = off


def thread_reveal(th, i, f, dur=5):
    """Bubble i pops in at f (and the thread scrolls up if it needs room)."""
    _scroll_to(th, i, f - 1, 3)
    pop_in(th['bubbles'][i], f, dur, over=1.08)


def thread_banner(th, f, hold=None):
    """The notification banner drops in at f (and leaves after hold frames, if given)."""
    bn = th['banner']
    z = bn.location.z
    key(bn, 'location', f - 1, (0, bn.location.y, z + 0.6))
    pop_in(bn, f, 5, over=1.05)
    key(bn, 'location', f + 5, (0, bn.location.y, z))
    if hold:
        key(bn, 'scale', f + 5 + hold, (1, 1, 1))
        key(bn, 'scale', f + 9 + hold, (0, 0, 0))


def vertical_outline(name, mon, aspect=9 / 16, depth=1.7, margin=0.5, drop=None, tick=None, tick_loc=None, glow=1.0, height=None):
    """A tall phone-video outline over a video_monitor's picture: a white emissive rounded frame, a dark see-through
    mask (alpha 0.85) in front of everything outside it (so whatever crosses its top edge is visibly cut off), generic
    app buttons down the right side (outline heart, speech bubble, paper plane, three dots) and a green tick disc.
    drop=f animates it in from the full 16:9 picture over 6 frames (hidden before); tick=f lands the tick with a
    bounce. depth: how far in front of the glass the mask sits; height overrides the outline height (picture height - margin). Returns a dict: root, outline, side, tick, masks, ow, oh."""
    cx, cy, cz = mon['center']
    root = empty(name, (cx, mon['glass_y'] - depth, cz))
    pw, ph = mon['pw'], mon['ph']
    oh = height or (ph - margin)
    ow = oh * aspect
    big = pw / 2 + 3.0
    mask = mat(name + 'Mask', (0.02, 0.02, 0.03), rough=0.9, alpha=0.85)
    masks = {}
    for side, s in (('L', -1), ('R', 1)):
        e = empty(name + 'Edge' + side, (s * ow / 2, 0, 0), root)
        p = rbox(name + 'Mask' + side, (s * big / 2, 0, 0), (big, 0.02, oh), 0.0, mask, e, segs=1)
        p.modifiers.clear()
        p.visible_shadow = False
        masks[side] = e
    for side, s in (('T', 1), ('B', -1)):
        p = rbox(name + 'Mask' + side, (0, 0, s * (oh / 2 + 4.0)), (2 * big + 4, 0.02, 8.0), 0.0, mask, root, segs=1)
        p.modifiers.clear()
        p.visible_shadow = False
        masks[side] = p
    wm = mat(name + 'White', (1, 1, 1), emit=(1, 1, 1), strength=2.0 * glow)
    oroot = empty(name + 'Frame', (0, -0.03, 0), root)
    outline = _poly_curve(name + 'Outline', _rrect_pts(ow, oh, 0.7), 0.1, wm, oroot, cyclic=True)
    side = empty(name + 'Side', (ow / 2 - 0.75, -0.05, 0), root)
    t = 0.06
    _poly_curve(name + 'BtnHeart', _heart_pts(0.022 * 10), t, wm, side, cyclic=True, loc=(0, 0, 1.6))
    circ = [(0.32 * math.cos(a), 0, 0.27 * math.sin(a)) for a in [i * 2 * math.pi / 28 for i in range(28)]]
    _poly_curve(name + 'BtnBubble', circ, t, wm, side, cyclic=True, loc=(0, 0, 0.45))
    _poly_curve(name + 'BtnBubbleTail', [(-0.2, 0, -0.18), (-0.3, 0, -0.42), (-0.05, 0, -0.26)], t, wm, side, loc=(0, 0, 0.45))
    _poly_curve(name + 'BtnPlane', [(-0.32, 0, 0.0), (0.32, 0, 0.26), (0.05, 0, -0.3), (-0.05, 0, -0.04)], t, wm, side, cyclic=True, loc=(0, 0, -0.7))
    _poly_curve(name + 'BtnPlane2', [(-0.05, 0, -0.04), (0.32, 0, 0.26)], t * 0.8, wm, side, loc=(0, 0, -0.7))
    for k in range(3):
        sphere(name + 'Dot%d' % k, (-0.22 + k * 0.22, 0, -1.75), (0.07, 0.03, 0.07), wm, side, seg=12)
    # the tick
    tl = tick_loc or (ow / 2 + 1.5, -0.1, oh / 2 - 1.3)
    tk = empty(name + 'Tick', tl, root)
    green = mat(name + 'Green', (0.15, 0.85, 0.35), emit=(0.15, 0.85, 0.35), strength=1.4 * glow)
    cylinder(name + 'TickDisc', (0, 0, 0), 0.95, 0.08, green, tk, rot=(math.pi / 2, 0, 0), verts=40)
    _poly_curve(name + 'TickCheck', [(-0.45, 0, 0.0), (-0.12, 0, -0.32), (0.48, 0, 0.36)], 0.11, wm, tk, loc=(0, -0.08, 0))
    if tick is not None:
        pop_in(tk, tick, 7, over=1.3)
    else:
        tk.scale = (0, 0, 0)
    if drop is not None:
        show(root, 0, False)
        show(root, drop, True)
        for sd, s in (('L', -1), ('R', 1)):
            e = masks[sd]
            key(e, 'location', drop, (s * pw / 2, 0, 0))
            key(e, 'location', drop + 6, (s * ow / 2, 0, 0), 'back')
        key(oroot, 'scale', drop, (pw / ow, 1, (ph + 0.1) / oh))
        key(oroot, 'scale', drop + 6, (1, 1, 1), 'back')
        key(side, 'location', drop, (pw / 2 - 0.75, -0.05, 0))
        key(side, 'location', drop + 6, (ow / 2 - 0.75, -0.05, 0), 'back')
    return {'root': root, 'outline': outline, 'frame': oroot, 'side': side, 'tick': tk, 'masks': masks, 'ow': ow, 'oh': oh}


def robot_sign(name, text='(it tried.\n412 times.)', parent_hand=None, rot=(0, 0, 0), ink=(0.12, 0.1, 0.12), upright=True):
    """A popsicle-stick sign held in a robot hand: white card 1.6 x 0.9 with hand-lettered lines (Montserrat-Bold,
    per-letter jitter). The stick's bottom sits at the hand. upright=True keeps it upright and facing the way the
    robot faces (-Y) whatever the arm does (rot then tilts it); otherwise it turns with the hand. Returns its root."""
    root = empty(name, (0, -0.05, 0), parent_hand)
    if upright and parent_hand is not None:
        top = parent_hand
        while top.parent:
            top = top.parent
        con = root.constraints.new('COPY_ROTATION')
        con.target = top
    tilt = empty(name + 'Tilt', (0, 0, 0), root)
    tilt.rotation_euler = rot
    out, root = root, tilt
    wood = mat(name + 'Stick', (0.86, 0.68, 0.42), rough=0.7)
    rbox(name + 'StickMesh', (0, 0, 0.45), (0.1, 0.04, 1.1), 0.04, wood, root, segs=2)
    rbox(name + 'Card', (0, -0.04, 1.35), (1.6, 0.04, 0.9), 0.05, mat(name + 'CardM', (0.98, 0.97, 0.94), rough=0.6), root, segs=2)
    im = mat(name + 'Ink', ink, rough=0.6)
    lines = text.split('\n')
    for i, ln in enumerate(lines):
        zc = 1.35 + (len(lines) - 1) * 0.17 - i * 0.34
        hand_text(name + 'Line%d' % i, ln, (0.0, -0.075, zc), 0.27, im, root, jit_rot=0.08, jit_off=0.04, extrude=0.005)
    return out


def _mini_picture(name, parent, w, h, glow=0.8):
    """A cream/peach picture with a whole croissant and its steam fully inside (for frame cards)."""
    pic = rbox(name + 'Pic', (0, -0.02, 0), (w, 0.02, h), 0.04, grad_mat(name + 'PicM', (0.5, 0.26, 0.14), (1.0, 0.86, 0.68), glow=glow, mid=(0.4, (0.95, 0.62, 0.42))), parent, segs=1)
    pic.modifiers.remove(pic.modifiers['sub'])
    s = min(0.62 * w / 3.4, 0.36 * h / 1.6)
    cro = croissant(name + 'Cro', (0, -0.08, -h / 2 + 0.12 * h + 0.45 * s), s, parent, depth=0.2)
    top = 1.1 * s
    room = (h / 2 - 0.08 * h) - (cro['root'].location.z + top)
    steam_wisp(name + 'Steam', (0.05, 0.0, 1.0), height=max(0.3, room / s - 0.1), parent=cro['root'], width=0.18)
    return cro


def size_cards(name, loc, fan=None, size=1.0):
    """Three thin white-bordered frame cards (9:16, 1:1, 16:9), each with a mini croissant and its steam fully inside.
    They start stacked; fan=f deals them out (tall left, square middle, wide right) with staggered keys over 12
    frames. Faces -Y. Returns a dict: root, cards (tall, square, wide)."""
    root = empty(name, loc)
    root.scale = (size, size, size)
    frame = mat(name + 'Border', (0.98, 0.98, 0.97), rough=0.5, emit=(1, 1, 1), strength=0.05)
    dims = [(1.35, 2.4), (1.9, 1.9), (2.6, 1.46)]
    finals = [((-2.45, -0.02, 0.1), 0.1), ((0.0, -0.04, 0.0), 0.0), ((2.6, -0.06, -0.15), -0.08)]
    cards = []
    for i, ((w, h), (pos, rz)) in enumerate(zip(dims, finals)):
        c = empty(name + 'Card%d' % i, (0, -0.06 * i, 0), root)
        rb = rbox(name + 'Frame%d' % i, (0, 0, 0), (w + 0.16, 0.03, h + 0.16), 0.05, frame, c, segs=2)
        rb.modifiers.remove(rb.modifiers['sub'])
        rbox(name + 'Edge%d' % i, (0, 0.02, 0), (w + 0.22, 0.02, h + 0.22), 0.06, mat(name + 'EdgeM%d' % i, (0.35, 0.3, 0.28), rough=0.8), c, segs=1).modifiers.clear()
        _mini_picture(name + 'P%d' % i, c, w, h)
        if fan is not None:
            f0 = fan + i * 4
            key(c, 'location', f0, (0, -0.06 * i, 0))
            key(c, 'rotation_euler', f0, (0, (i - 1) * 0.05, 0))
            key(c, 'location', f0 + 6, pos, 'back')
            key(c, 'rotation_euler', f0 + 6, (0, rz, 0), 'back')
        else:
            c.location = pos
            c.rotation_euler = (0, rz, 0)
        cards.append(c)
    return {'root': root, 'cards': cards}


# --- robot extensions


def robot_fingers(c):
    """Give the robot three stub fingers on each round hand (pivots: c.fingersL / c.fingersR, index 0 outermost).
    They start curled. Use count_fingers, lose_count and knuckle_crack. Returns {'L': [...], 'R': [...]}."""
    dark = bpy.data.materials[c.name + 'Joint']
    out = {}
    for side, hand in (('L', c.handL), ('R', c.handR)):
        s = -1 if side == 'L' else 1
        fs = []
        for k, dx in enumerate((-0.065, 0.0, 0.065)):
            piv = empty(c.name + 'Finger%s%d' % (side, k), (s * dx, -0.04, -0.07), hand)
            sphere(c.name + 'FingerMesh%s%d' % (side, k), (0, 0, -0.07), (0.034, 0.034, 0.078), dark, piv, seg=16)
            piv.rotation_euler = (1.5, 0, 0)
            fs.append(piv)
        out[side] = fs
    c.fingersL, c.fingersR = out['L'], out['R']
    return out


def _finger(piv, f, up, spread):
    key(piv, 'rotation_euler', f, (0.0 if up else 1.5, spread if up else 0.0, 0))


def count_fingers(c, f, n, arms=True):
    """Show n raised fingers (0-6, left hand first) at frame f; arms=True lifts both hands up to show them."""
    order = list(c.fingersL) + list(c.fingersR)
    for i, piv in enumerate(order):
        spread = (i % 3 - 1) * 0.28
        _finger(piv, f, i < n, spread)
    if arms:
        c.arm('L', f, up=2.2, fwd=-0.4)
        c.arm('R', f, up=2.2, fwd=-0.4)


def lose_count(c, f, dur=12):
    """Fingers flicker up and down out of order, head tilts, eyes squint: lost count."""
    order = list(c.fingersL) + list(c.fingersR)
    for t in range(0, dur, 3):
        for i, piv in enumerate(order):
            _finger(piv, f + t, (i * 7 + t) % 3 == 0, 0.2)
    key(c.head, 'rotation_euler', f, (0, 0, 0))
    key(c.head, 'rotation_euler', f + 6, (0, 0.28, 0.1))
    c.eyes_shape(f + 4, 1.1, 0.55)


def knuckle_crack(c, f):
    """Both hands forward and together, fingers flex twice: I got this. About 12 frames."""
    for side, s in (('L', -1), ('R', 1)):
        c.arm(side, f, up=-0.6, fwd=-1.2)
    for t, up in ((2, True), (5, False), (7, True), (10, False), (12, True)):
        for piv in list(c.fingersL) + list(c.fingersR):
            _finger(piv, f + t, up, 0.0)
    c.squash(f + 5, 0.92)
    c.squash(f + 8, 1.05)
    c.squash(f + 12, 1.0)


def badge_standin(name, mon, text='Seems like AI slop', loc=None, height=2.4, depth=1.3):
    """A 3D copy of the grey overlay badge (generic rounded pill, neutral circle icon, Inter-Bold dark text) at the
    video's top-right corner, so shatter() and dust_burst() can break it when the overlay cuts. Returns its root."""
    cx, cy, cz = mon['center']
    tw = text_widths([text], height * 0.42, 'Inter-Bold.ttf')[0]
    bw = tw + height * 1.45
    if loc is None:
        right = min(8.4, mon['pw'] / 2 - 0.6)
        loc = (cx + right - bw / 2, mon['glass_y'] - depth, cz + mon['ph'] / 2 - 0.5 - height / 2)
    root = empty(name, loc)
    grey = mat(name + 'Pill', (0.55, 0.55, 0.56), rough=0.45, coat=0.3)
    rbox(name + 'PillMesh', (0, 0, 0), (bw, 0.12, height), height * 0.48, grey, root, segs=4)
    cylinder(name + 'Icon', (-bw / 2 + height * 0.55, -0.07, 0), height * 0.28, 0.03, mat(name + 'IconM', (0.88, 0.88, 0.89), rough=0.5), root, rot=(math.pi / 2, 0, 0), verts=32)
    cylinder(name + 'IconDot', (-bw / 2 + height * 0.55, -0.09, 0), height * 0.12, 0.03, mat(name + 'IconDotM', (0.35, 0.35, 0.37), rough=0.5), root, rot=(math.pi / 2, 0, 0), verts=24)
    _mk_text(name + 'Text', text, (-bw / 2 + height * 1.0, -0.08, 0), height * 0.42, mat(name + 'Ink', (0.08, 0.08, 0.09), rough=0.6), root, font='Inter-Bold.ttf', extrude=0.01, align='LEFT')
    return root
