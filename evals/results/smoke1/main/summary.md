# Eval smoke1 · main

2026-10-04T02:41:31.721Z · model claude-opus-5-5 · package 0.1.0

**1/1 passed (100 %)**, mean score 1, mean turns 21, mean tokens 779k (total 779k, cost $0.45), mean wall 63 s, agent timeouts 0, shell timeouts 0, failed edits 0, violations 5.

| task | pass | score | turns | tokens | time s | shell timeouts | failed edits | errors | verbs |
|---|---|---|---|---|---|---|---|---|---|
| gif-export | yes | 1 | 21 | 779k | 63 | 0 | 0 | E_CODE×1 E_BUS_CYCLE×1 E_ENCODE×2 E_FORMAT×1 E_DUPLICATE_ID×1 E_EMPTY×1 E_EXISTS×1 E_EXPORT×1 | docs×5 show×2 render×5 edit×4 check×1 |

Most common errors: E_ENCODE (2), E_CODE (1), E_BUS_CYCLE (1), E_FORMAT (1), E_DUPLICATE_ID (1), E_EMPTY (1), E_EXISTS (1), E_EXPORT (1)
CLI verbs used: docs (5), render (5), edit (4), show (2), check (1)

## Failed checks


## Sandbox violations

- gif-export: `Bash: grep -c NETSCAPE2.0 out/clip.gif; python3 -c "
d=open('out/clip.gif','rb').read();i=d.find(b'NETSCAPE2.0');print(d[i:i+16])"; ffmpeg -v error -i out/clip.gif -vf "select='eq(n\,0)+eq(n\,44)',tile=2x1" -frames:v 1 -y /tmp/claude-0/-tmp-mgl-eval-gif-export-6E2xlj/7bfc27cd-f80d-56c5-a33a-82740a69`
- gif-export: `Read: /tmp/claude-0/-tmp-mgl-eval-gif-export-6E2xlj/7bfc27cd-f80d-56c5-a33a-82740a693a5c/scratchpad/frames.png`
- gif-export: `Bash: npx mgl render demo.mgl.json /tmp/claude-0/-tmp-mgl-eval-gif-export-6E2xlj/7bfc27cd-f80d-56c5-a33a-82740a693a5c/scratchpad/s3.png --still 3s 2>&1 | tail -1`
- gif-export: `Read: /tmp/claude-0/-tmp-mgl-eval-gif-export-6E2xlj/7bfc27cd-f80d-56c5-a33a-82740a693a5c/scratchpad/s3.png`
- gif-export: `Bash: ffmpeg -v error -i out/clip.gif -vf "select='eq(n\,0)+eq(n\,44)',tile=1x2" -frames:v 1 -y /tmp/claude-0/-tmp-mgl-eval-gif-export-6E2xlj/7bfc27cd-f80d-56c5-a33a-82740a693a5c/scratchpad/frames.png; ffprobe -v error -show_entries stream=width,height,r_frame_rate,nb_frames:format=duration,size -of`
