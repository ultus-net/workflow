export interface MotionProject {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationFrames: number;
  readonly renderFrame: (frame: number) => string;
}

export interface MotionKeyframe<T> {
  readonly frame: number;
  readonly value: T;
}

export interface MotionCell {
  readonly x: number;
  readonly y: number;
  readonly value: string;
}

export interface MotionLayer {
  readonly cells?: readonly MotionCell[];
  readonly renderFrame?: (frame: number) => string;
  readonly x?: readonly MotionKeyframe<number>[];
  readonly y?: readonly MotionKeyframe<number>[];
}

export interface MotionScene {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationFrames: number;
  readonly layers: readonly MotionLayer[];
}

export function createMotionProject(project: MotionProject): MotionProject {
  if (!Number.isInteger(project.width) || !Number.isInteger(project.height) || project.width <= 0 || project.height <= 0) {
    throw new RangeError("Motion project dimensions must be positive integers");
  }
  if (!Number.isFinite(project.frameRate) || project.frameRate <= 0) {
    throw new RangeError("Motion project frame rate must be positive");
  }
  if (!Number.isInteger(project.durationFrames) || project.durationFrames <= 0) {
    throw new RangeError("Motion project duration must be a positive integer");
  }
  return Object.freeze({ ...project });
}

export function createMotionSceneProject(scene: MotionScene): MotionProject {
  return createMotionProject({
    width: scene.width,
    height: scene.height,
    frameRate: scene.frameRate,
    durationFrames: scene.durationFrames,
    renderFrame(frame) {
      const cells = Array.from({ length: scene.height }, () => Array<string>(scene.width).fill(" "));
      for (const layer of scene.layers) {
        const translateX = layer.x ? interpolateKeyframes(layer.x, frame) : 0;
        const translateY = layer.y ? interpolateKeyframes(layer.y, frame) : 0;
        if (!Number.isFinite(translateX) || !Number.isFinite(translateY)) {
          throw new RangeError("Motion layer translations must resolve to finite numbers");
        }
        const offsetX = Math.round(translateX);
        const offsetY = Math.round(translateY);
        if (layer.renderFrame) {
          const lines = layer.renderFrame(frame).split("\n");
          for (let y = 0; y < lines.length; y++) {
            if (![...lines[y]!].every(isSafeTerminalCell)) throw new RangeError("Motion renderer layers require safe terminal cells");
            for (let x = 0; x < lines[y]!.length; x++) compositeCell(cells, x + offsetX, y + offsetY, lines[y]![x]!);
          }
        }
        for (const cell of layer.cells ?? []) {
          if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y) || !isSafeTerminalCell(cell.value)) {
            throw new RangeError("Motion cells require integer coordinates and one safe terminal cell");
          }
          compositeCell(cells, cell.x + offsetX, cell.y + offsetY, cell.value);
        }
      }
      return cells.map((row) => row.join("")).join("\n");
    },
  });
}

export function renderMotionFrame(project: MotionProject, frame: number): string {
  if (!Number.isInteger(frame) || frame < 0 || frame >= project.durationFrames) {
    throw new RangeError("Motion frame must be within the project duration");
  }
  const output = project.renderFrame(frame);
  const lines = output.split("\n");
  if (lines.length !== project.height || lines.some((line) => line.length !== project.width)) {
    throw new RangeError("Rendered motion frame must match the project dimensions");
  }
  return output;
}

export function interpolateKeyframes<T>(keyframes: readonly MotionKeyframe<T>[], frame: number): T {
  if (keyframes.length === 0) throw new RangeError("Motion keyframes cannot be empty");
  if (!Number.isInteger(frame) || frame < 0 || keyframes.some((keyframe) => !Number.isInteger(keyframe.frame) || keyframe.frame < 0)) {
    throw new RangeError("Motion keyframes and query frames must be non-negative integers");
  }
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  if (frame <= sorted[0]!.frame) return sorted[0]!.value;
  if (frame >= sorted.at(-1)!.frame) return sorted.at(-1)!.value;

  const nextIndex = sorted.findIndex((keyframe) => keyframe.frame > frame);
  const from = sorted[nextIndex - 1]!;
  const to = sorted[nextIndex]!;
  if (typeof from.value !== "number" || typeof to.value !== "number") return from.value;
  const progress = (frame - from.frame) / (to.frame - from.frame);
  return (from.value + (to.value - from.value) * progress) as T;
}

export function insertMotionFrames<T>(keyframes: readonly MotionKeyframe<T>[], atFrame: number, count: number): MotionKeyframe<T>[] {
  validateTimelineEdit(atFrame, count);
  return keyframes.map((keyframe) => keyframe.frame < atFrame ? { ...keyframe } : { ...keyframe, frame: keyframe.frame + count });
}

export function removeMotionFrames<T>(keyframes: readonly MotionKeyframe<T>[], atFrame: number, count: number): MotionKeyframe<T>[] {
  validateTimelineEdit(atFrame, count);
  const endFrame = atFrame + count;
  return keyframes
    .filter((keyframe) => keyframe.frame < atFrame || keyframe.frame >= endFrame)
    .map((keyframe) => keyframe.frame < endFrame ? { ...keyframe } : { ...keyframe, frame: keyframe.frame - count });
}

export function frameAtElapsedTime(elapsedMs: number, frameRate: number, durationFrames: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError("Elapsed time must be non-negative");
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new RangeError("Frame rate must be positive");
  if (!Number.isInteger(durationFrames) || durationFrames <= 0) throw new RangeError("Duration must be a positive integer");
  return Math.floor(elapsedMs * frameRate / 1000) % durationFrames;
}

export function exportMotionFrames(project: MotionProject): readonly string[] {
  return Array.from({ length: project.durationFrames }, (_, frame) => renderMotionFrame(project, frame));
}

function validateTimelineEdit(atFrame: number, count: number): void {
  if (!Number.isInteger(atFrame) || atFrame < 0 || !Number.isInteger(count) || count <= 0) {
    throw new RangeError("Motion timeline edits require a non-negative frame and positive integer count");
  }
}

function compositeCell(output: string[][], x: number, y: number, value: string): void {
  if (value === " " || y < 0 || y >= output.length || x < 0 || x >= output[0]!.length) return;
  output[y]![x] = value;
}

function isSafeTerminalCell(value: string): boolean {
  if ([...value].length !== 1) return false;
  const codePoint = value.codePointAt(0)!;
  return codePoint >= 0x20 && codePoint <= 0x7e || codePoint >= 0x2800 && codePoint <= 0x28ff;
}
