import { BrailleCanvas } from "./braille-canvas.js";
import { createMotionProject, createMotionSceneProject, type MotionProject } from "./motion.js";

const WIDTH = 29;
const HEIGHT = 5;
const DOT_WIDTH = WIDTH * 2;
const DOT_HEIGHT = HEIGHT * 4;
const TAU = Math.PI * 2;

export interface WorkflowMotionExample {
  readonly name: string;
  readonly description: string;
  readonly project: MotionProject;
}

function procedural(durationFrames: number, render: (canvas: BrailleCanvas, phase: number) => void): MotionProject {
  return createMotionProject({
    width: WIDTH,
    height: HEIGHT,
    frameRate: 8,
    durationFrames,
    renderFrame(frame) {
      const canvas = new BrailleCanvas(WIDTH, HEIGHT);
      render(canvas, frame * TAU / durationFrames);
      return canvas.render();
    },
  });
}

const particles = procedural(24, (canvas, phase) => {
  for (let index = 0; index < 22; index++) {
    const angle = index * 2.399963 + phase;
    const radius = 2 + index * 0.78;
    canvas.setPixel(Math.round(DOT_WIDTH / 2 + Math.cos(angle) * radius * 1.6), Math.round(DOT_HEIGHT / 2 + Math.sin(angle) * radius * 0.48));
  }
});

const contours = procedural(32, (canvas, phase) => {
  for (let band = 0; band < 4; band++) {
    const points = Array.from({ length: DOT_WIDTH }, (_, x) => ({
      x,
      y: 3 + band * 4 + Math.sin(x * 0.19 + phase + band * 0.8) * (1.3 + band * 0.2),
    }));
    canvas.polyline(points);
  }
});

const interference = procedural(24, (canvas, phase) => {
  for (let x = 0; x < DOT_WIDTH; x++) {
    const a = Math.sin(x * 0.27 + phase) * 4;
    const b = Math.sin(x * 0.43 - phase * 1.5) * 3;
    canvas.setPixel(x, Math.round(DOT_HEIGHT / 2 + a + b));
    canvas.setPixel(x, Math.round(DOT_HEIGHT / 2 + a - b));
  }
});

const aperture = procedural(20, (canvas, phase) => {
  const openness = 2.5 + (Math.sin(phase) + 1) * 3.5;
  for (let blade = 0; blade < 6; blade++) {
    const angle = blade * TAU / 6 + phase * 0.15;
    const inner = { x: DOT_WIDTH / 2 + Math.cos(angle) * openness, y: DOT_HEIGHT / 2 + Math.sin(angle) * openness * 0.55 };
    const outerAngle = angle + 0.72;
    const outer = { x: DOT_WIDTH / 2 + Math.cos(outerAngle) * 25, y: DOT_HEIGHT / 2 + Math.sin(outerAngle) * 9 };
    canvas.line(inner, outer);
  }
});

const type = createMotionSceneProject({
  width: WIDTH,
  height: HEIGHT,
  frameRate: 8,
  durationFrames: 20,
  layers: [
    { cells: [..."MOTION"].map((value, index) => ({ x: index * 2, y: 1, value })), x: [{ frame: 0, value: -10 }, { frame: 10, value: 9 }, { frame: 19, value: 18 }] },
    { cells: [..."FRAME"].map((value, index) => ({ x: index * 2, y: 3, value })), x: [{ frame: 0, value: 28 }, { frame: 10, value: 10 }, { frame: 19, value: -9 }] },
  ],
});

const rain = createMotionSceneProject({
  width: WIDTH,
  height: HEIGHT,
  frameRate: 8,
  durationFrames: 20,
  layers: [
    { cells: Array.from({ length: 9 }, (_, index) => ({ x: index * 4, y: index % 4, value: index % 2 ? ":" : "|" })), y: [{ frame: 0, value: -3 }, { frame: 19, value: 5 }] },
    { cells: Array.from({ length: 7 }, (_, index) => ({ x: 2 + index * 5, y: index % 5, value: "." })), y: [{ frame: 0, value: 4 }, { frame: 19, value: -4 }] },
  ],
});

export const WORKFLOW_MOTION_EXAMPLES: readonly WorkflowMotionExample[] = Object.freeze([
  { name: "particles", description: "Rotating Braille particle cloud", project: particles },
  { name: "type", description: "Counter-moving ASCII typography", project: type },
  { name: "contours", description: "Layered Braille contour field", project: contours },
  { name: "interference", description: "Crossing Braille wave interference", project: interference },
  { name: "aperture", description: "Opening mechanical Braille iris", project: aperture },
  { name: "rain", description: "Opposing sparse ASCII rainfall", project: rain },
]);
