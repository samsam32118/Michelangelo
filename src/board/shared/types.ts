/**
 * The board's data contract (docs/plans/BOARD.md §3, §5, §6). Shared by Node (model, server, CLI, snapshot) and the
 * browser page. This folder imports nothing outside itself: no Node, no DOM, no packages.
 */

export const BOARD_FORMAT = 1;

export type Who = 'human' | 'ai';
export type PaletteName = 'yellow' | 'blue' | 'green' | 'red' | 'violet' | 'grey' | 'black' | 'white';
export type Fidelity = 'thumb' | 'half' | 'full';
/** 0 sketch · 1 frames · 2 sheet · 3 draft · 4 final */
export type Level = 0 | 1 | 2 | 3 | 4;
/** A time in any edge form of DESIGN §3: frames (75), "2.5s", "1:02.5", "00:00:02:15". */
export type TimeLike = number | string;
export type Point = [number, number];

export interface ShapeBase {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  w?: number;
  h?: number;
  rot?: number;
  parent?: string;
  label?: string;
  color?: PaletteName;
  by?: Who;
  locked?: boolean;
  tags?: string[];
}

export interface FrameShape extends ShapeBase { type: 'frame' }
export interface NoteShape extends ShapeBase { type: 'note'; text?: string }
export interface TextShape extends ShapeBase { type: 'text'; text?: string; size?: number }
export interface GeoShape extends ShapeBase { type: 'rect' | 'ellipse'; text?: string; fill?: 'none' | 'solid' | 'tint' }
export interface ArrowShape extends ShapeBase { type: 'arrow'; from?: string | Point; to?: string | Point; text?: string }
export interface DrawShape extends ShapeBase { type: 'draw'; points: Point[] }
export interface ImageShape extends ShapeBase { type: 'image'; src: string }
/** `project`: a variant (a sibling project file, relative to the board) rendered through the same still cache */
export interface StillShape extends ShapeBase { type: 'still'; t: TimeLike; comp?: string; fidelity?: Fidelity; project?: string }
export interface TimelineShape extends ShapeBase { type: 'timeline'; comp?: string; from?: TimeLike; to?: TimeLike }
export interface PinShape extends ShapeBase { type: 'pin'; target: string; u?: number; v?: number; text?: string; status?: 'open' | 'resolved'; reply?: string }

export type Shape = FrameShape | NoteShape | TextShape | GeoShape | ArrowShape | DrawShape | ImageShape | StillShape | TimelineShape | PinShape;
export type ShapeType = 'frame' | 'note' | 'text' | 'rect' | 'ellipse' | 'arrow' | 'draw' | 'image' | 'still' | 'timeline' | 'pin';
export const SHAPE_TYPES: readonly ShapeType[] = ['frame', 'note', 'text', 'rect', 'ellipse', 'arrow', 'draw', 'image', 'still', 'timeline', 'pin'];

export interface Brief {
  goal?: string;
  audience?: string;
  platform?: string;
  length?: string;
  tone?: string[];
  references?: string[];
  mustHave?: string[];
  avoid?: string[];
  success?: string[];
  questions?: string[];
  budget?: { cpuMin?: number; maxLevel?: Level };
}

export interface RoundOption {
  id: string;
  title: string;
  summary?: string;
  shapes?: string[];
  tradeoffs?: string;
  cost?: string;
  taste?: string;
  /** a variant: a sibling project file (relative to the board) that pictures this option */
  project?: string;
}

export interface Round {
  id: string;
  goal: string;
  fidelity: Level;
  status: 'open' | 'proposed' | 'decided' | 'dropped';
  options?: RoundOption[];
  chosen?: string;
  why?: string;
  notes?: string;
}

/** `re`: the log ids this message answers */
export interface LogEntry { id: string; by: Who; text: string; at?: string; re?: string[] }
export interface SpendEntry { id: string; level: Level; what: string; ms: number; round?: string }

export interface BoardFile {
  michelangeloBoard: 1;
  project?: string;
  brief?: Brief;
  shapes?: Shape[];
  rounds?: Round[];
  log?: LogEntry[];
  spend?: SpendEntry[];
}

/** An op is plain JSON: {"op": "shape.add", ...}. `by` is filled in by the door (page: human; CLI/console: ai). */
export type BoardOp =
  | { op: 'shape.add'; shape: Partial<Shape> & { type: ShapeType } }
  | { op: 'shape.set'; id: string; props: Record<string, unknown> }
  | { op: 'shape.remove'; id?: string; ids?: string[] }
  | { op: 'shape.move'; ids: string[]; dx: number; dy: number }
  | { op: 'shape.order'; ids: string[]; to: 'front' | 'back' | 'forward' | 'backward' }
  | ({ op: 'brief.set'; add?: Record<string, string[]>; remove?: Record<string, string[]> } & Partial<Brief>)
  | { op: 'round.open'; goal: string; fidelity?: Level; id?: string }
  | { op: 'round.option'; round: string; option: Partial<RoundOption> & { title: string } }
  | { op: 'round.decide'; round: string; chosen: string; why?: string }
  | { op: 'round.set'; round: string; props: Partial<Pick<Round, 'status' | 'notes' | 'goal' | 'fidelity'>> }
  | { op: 'pin.add'; target: string; u?: number; v?: number; text: string }
  | { op: 'pin.resolve'; id: string; reply?: string }
  | { op: 'say'; text: string; re?: string | string[] }
  | { op: 'still.add'; t: TimeLike; comp?: string; fidelity?: Fidelity; x?: number; y?: number; parent?: string; project?: string }
  | { op: 'storyboard.make'; frame?: string; every?: TimeLike; cuts?: boolean; fidelity?: Fidelity }
  | { op: 'spend.add'; level: Level; what: string; ms: number; round?: string };

export type OpName = BoardOp['op'];

/** The project as the board sees it (GET /api/state `project`, SSE `project`, mgl.timeline()). */
export interface Outline {
  file: string;
  main: string;
  comps: { id: string; size: [number, number]; fps: number; length: number }[];
  tracks: { id: string; comp: string; audio?: boolean }[];
  clips: { id: string; track: string; at: number; len: number; kind: string; label: string }[];
  /** content hash of the project file: still cache keys and change detection */
  hash: string;
}

export interface Camera { x: number; y: number; zoom: number }
export interface Presence { by: Who; camera?: Camera; selection?: string[]; cursor?: Point; inView?: string[]; at?: number }

export interface Advice { level: 'ask' | 'do' | 'wait' | 'warn'; text: string; ids?: string[] }

/** POST /api/ops result. */
export type OpsResult =
  | { ok: true; version: number; changed: string[]; created?: string[] }
  | { ok: false; error: { code: string; message: string; fix?: string } };

/** GET /api/state */
export interface BoardState { board: BoardFile; version: number; project: Outline | null; view: Partial<Record<Who, Presence>>; /** advise() output, when the server includes it */ advice?: Advice[] }
