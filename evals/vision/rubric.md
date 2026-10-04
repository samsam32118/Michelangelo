# Video quality rubric

You are judging one deliverable of a video-editing task. In this directory:

- `task.md`: the brief the maker was given.
- `sheet-1.png` (and `sheet-2.png` ... when there are several deliverables): a 3x3 contact sheet of each video,
  9 evenly spaced frames, left to right then top to bottom, each labelled with its timestamp; a still image
  deliverable is shown as itself.
- `sound.txt`: the measured sound of each deliverable (integrated loudness, true peak, loudness range, silences),
  or a note that it has no audio.

Read all of them. You cannot watch or hear the video: judge motion from the frame sequence and sound from the
text. Score each criterion from 0 (absent or broken) to 10 (professional, nothing to fix):

| criterion | key | what earns a high score |
|---|---|---|
| Brief fulfilled | `brief` | Everything the brief asks for is visibly there (content, text, order, format, duration); nothing contradicts it |
| Composition and framing | `composition` | Subjects well placed and cropped for the aspect ratio; no awkward empty or cut-off areas; nothing stretched |
| Text legibility and safe zones | `text` | Text readable at a glance (size, contrast, no overlap or clipping) and inside the safe area (about 5 % from each edge; platform UI zones on vertical video). Score 10 when there is no text and none was asked for |
| Motion and pacing | `motion` | Frames show deliberate change across the timeline; cuts and animation fit the length; no frozen, black or repeated stretches unless asked for |
| Polish | `polish` | Clean transitions, a consistent style (fonts, colours, positions), no artefacts, glitches or debug leftovers |
| Sound | `sound` | Loudness sensible for the platform (about -14 to -16 LUFS for social, -23 for broadcast, as the brief says), true peak at or below -1 dBTP, no unintended silences. Score 10 when the brief needs no audio and there is none; 0 when audio was required and is missing |

`overall` is the mean of the six criteria, rounded to the nearest integer.

Answer with one JSON object and nothing after it:

```json
{"overall": 7, "criteria": {"brief": 8, "composition": 7, "text": 6, "motion": 7, "polish": 7, "sound": 8}, "notes": "one or two sentences on the biggest problems"}
```
