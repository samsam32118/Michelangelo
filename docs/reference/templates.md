# Templates

A template generates ordinary entities (clips, sometimes a comp, tracks, styles, cues) from a few
parameters. Once applied they are plain lines you can edit like any other; the clips are tagged
`"template:<id>"` and their ids share a prefix (`lower-third-name`, `lower-third2-plate`, ...).

```sh
mgl new shorts -o tpl.mgl.json
mgl edit tpl.mgl.json template.apply intro params='{"title": "Three tips to focus", "subtitle": "in 30 seconds"}'
mgl edit tpl.mgl.json template.apply lower-third at=4s params='{"name": "Ada Lovelace", "role": "Engineer"}'
mgl edit tpl.mgl.json template.apply cta at=6s len=2s params='{"label": "Follow"}'
mgl show tpl.mgl.json
```

`template.apply <id> [at=] [len=] [track=] [comp=] [prefix=] params='{...}'`: layers go on free visual
tracks above existing content (new tracks are made when none is free), or on `track=`. `len=` asks for
another duration (templates adapt their timing to it). Parameter errors name the allowed parameters.

Built-in templates (parameters and defaults: `mgl docs template <id>`, or effects.md):

| id | what | main params |
|---|---|---|
| `intro` | title card: background, accents, popping title, sliding subtitle (4 s) | title, subtitle, bg, accent |
| `lower-third` | name and role on a plate with an accent bar, wipes in and out (5 s) | name, role, accent, plate |
| `cta` | call-to-action button that pops in and bounces, inside the safe zone (3 s) | label, color, textColor, y |
| `title` | big centred title, pops in word by word (3 s) | text, color |
| `end-card` | end screen with title, two video placeholders and a subtitle (5 s) | title, subtitle, bg, accent |
| `progress-bar` | a bar that fills over the comp length | color, trackColor, position, thickness |
| `quote` | a quotation with a large quote mark and the author (5 s) | quote, author, accent |
| `listicle-item` | a numbered list item (3 s) | number, text, accent, numberColor |

After applying, adjust with normal commands (`clip.set lower-third-name style.color=#ffffff`, `clip.move`,
`text.set`), or remove all of it: the ids are listed in the `edit` output (`--json` → `out[0].ids`).

```sh
mgl edit tpl.mgl.json --json template.apply listicle-item at=8s params='{"number": 1, "text": "Phone in another room"}' > applied.json
node -e "const r = require('./applied.json'); console.log(r.out[0].ids.join(' '))"
```

Plugins add templates (`mgl plugin new template <name>`): a `defineTemplate({ id, describe, params, build })`
whose `build` returns the entities with local ids; the core prefixes them and places their layers.
