"""Michelangelo says hi: floats in front of a studio sweep, waves and blinks. 2 seconds."""
def build(m):
    m.scene_setup(48, world=(0.75, 0.68, 0.85), world_strength=0.5)
    m.backdrop((0.86, 0.72, 0.92))
    m.studio_lights()
    c = m.Michelangelo(loc=(0, 0, 0.35))
    c.hover(1, 48)
    c.wave(4, cycles=3)
    c.smile_(4, 1.2)
    c.blink(36)
    m.camera((0.9, -6.2, 1.9), (0, 0, 1.45), lens=55, dof=6.2, fstop=4)
