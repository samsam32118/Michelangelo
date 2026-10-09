/** The board server and its renders (BOARD.md §4, §6.2): serve, find, stills, ladder, Skia snapshot. */
export { startBoardServer, findServer, DEFAULT_PORT, type ServeOptions, type BoardServer } from './http.js';
export { renderStill, renderLevel, recordSpend, currentRound, parseRange, stillWidth, THUMB_W, type StillResult, type RenderLevelOptions, type RenderLevelResult } from './render.js';
export { snapshotBoard, timecode, SNAPSHOT_MAX, type SnapshotOptions, type SnapshotResult } from './snapshot.js';
export { boardCacheDir, serverJsonPath, safeJoin } from './paths.js';
