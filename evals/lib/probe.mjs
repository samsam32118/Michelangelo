// ffprobe as plain data: duration, streams, codecs, size, fps, frame counts, rotation.
import { FFPROBE, run, isFile } from './util.mjs';

const rate = (s) => {
  if (!s || s === '0/0') return undefined;
  const [n, d] = String(s).split('/').map(Number);
  return d ? n / d : n;
};

/** Probe a media file. Returns undefined when the file is missing or unreadable. `countFrames` decodes to count. */
export async function probe(file, { countFrames = false } = {}) {
  if (!isFile(file)) return undefined;
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];
  if (countFrames) args.push('-count_frames');
  const r = await run(FFPROBE, [...args, file]);
  if (r.code !== 0) return undefined;
  let j;
  try { j = JSON.parse(r.stdout.toString()); } catch { return undefined; }
  const streams = (j.streams ?? []).map((s) => {
    const side = (s.side_data_list ?? []).find((x) => x.rotation !== undefined);
    return {
      index: s.index, type: s.codec_type, codec: s.codec_name, profile: s.profile, pixFmt: s.pix_fmt,
      width: s.width, height: s.height, fps: rate(s.avg_frame_rate) ?? rate(s.r_frame_rate), rFps: rate(s.r_frame_rate),
      duration: s.duration !== undefined ? Number(s.duration) : undefined,
      frames: s.nb_read_frames !== undefined ? Number(s.nb_read_frames) : s.nb_frames !== undefined ? Number(s.nb_frames) : undefined,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined, channels: s.channels,
      rotation: side ? Number(side.rotation) : s.tags?.rotate !== undefined ? -Number(s.tags.rotate) : 0,
    };
  });
  const video = streams.find((s) => s.type === 'video' && s.codec !== 'png' && s.codec !== 'mjpeg') ?? streams.find((s) => s.type === 'video');
  const audio = streams.find((s) => s.type === 'audio');
  const rot = video?.rotation ?? 0;
  const swap = Math.abs(rot) % 180 === 90;
  return {
    format: j.format?.format_name, size: Number(j.format?.size ?? 0),
    duration: Number(j.format?.duration ?? video?.duration ?? audio?.duration ?? 0),
    streams, video, audio,
    width: video?.width, height: video?.height,
    /** display size after rotation metadata */
    displayWidth: swap ? video?.height : video?.width, displayHeight: swap ? video?.width : video?.height,
    fps: video?.fps, frames: video?.frames, rotation: rot,
  };
}
