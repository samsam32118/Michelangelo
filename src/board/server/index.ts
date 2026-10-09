/** The board server and its renders (BOARD.md §4, §6.2): serve, find, stills, ladder, Skia snapshot. */
export { startBoardServer, findServer, DEFAULT_PORT, type ServeOptions, type BoardServer } from './http.js';
export { renderStill, renderLevel, estimateLevel, variantProject, recordSpend, currentRound, parseRange, stillWidth, timecode, THUMB_W, type StillResult, type RenderLevelOptions, type RenderLevelResult, type LevelEstimate } from './render.js';
export { snapshotBoard, SNAPSHOT_MAX, type SnapshotOptions, type SnapshotResult } from './snapshot.js';
export { exportBoard, EXPORT_MAX_FILES, type ExportOptions, type ExportResult } from './export.js';
export { boardCacheDir, serverJsonPath, safeJoin } from './paths.js';
