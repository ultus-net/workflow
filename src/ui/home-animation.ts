import { BrailleCanvas, type Point } from "./braille-canvas.js";
import { createMotionProject, createMotionSceneProject, exportMotionFrames } from "./motion.js";

const COLUMNS = 29;
const ROWS = 5;
const TAU = Math.PI * 2;

const RAVEN_WIDTH = 30;
const RAVEN_HEIGHT = 32;
const RAVEN_RGB = Buffer.from("/v7+/v7+/v7+/v7+/v7+/v7+/v7+AwMDAwMDAwMD/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+PDZaaV6gal2hal2hal2hal2jBwcC/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+ExMT2ca4QjtmQztsBgoB6+maBQYKOTFaPzZhExAV/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+DxEQkYmoRD1sQTtrRDtpBgQLAwMEm2MCODRaODFaJR9AODFb//7//v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+BgMHPDZgOTJZOTJZOTJWOTNUAwMBFxUqFxUqFxUqODFaODFaFhQiBgIN/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+BAMB/vz+/vz+/vz+AwEEDwwXEA0dEQ8kNzJZNzJaODFaIx49IRw6BQQO/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+BAEIEA0eEA0gGBUpODFeODFaJB5BNC5TGxguqKio/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+IBwsIBw1JSA+aFyiUEZ/MCpPNzBZFhUnFxUqqKio/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+T0V/SD9xOTBbNy9YODFaAwMCAwMCAwMCIRw4JiE/FxQn/Pz+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+BQUEa2ClMyxZRz1zOTFaaF2ibGGial2hal2hal2hcWSqBAMBBAMB/////v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+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", "base64");

function ravenPixel(x: number, y: number): readonly [number, number, number] {
  const offset = (y * RAVEN_WIDTH + x) * 3;
  return [RAVEN_RGB[offset] ?? 255, RAVEN_RGB[offset + 1] ?? 255, RAVEN_RGB[offset + 2] ?? 255];
}

function isRavenBackground([red, green, blue]: readonly [number, number, number]): boolean {
  return red >= 235 && green >= 235 && blue >= 235;
}

function ravenColor([red, green, blue]: readonly [number, number, number], background = false): string {
  return `\x1b[${background ? 48 : 38};2;${red};${green};${blue}m`;
}

export const WORKFLOW_HOME_ART = Array.from({ length: RAVEN_HEIGHT / 2 }, (_, row) => {
  let line = "";
  for (let x = 0; x < RAVEN_WIDTH; x++) {
    const upper = ravenPixel(x, row * 2);
    const lower = ravenPixel(x, row * 2 + 1);
    const upperBackground = isRavenBackground(upper);
    const lowerBackground = isRavenBackground(lower);
    if (upperBackground && lowerBackground) line += " ";
    else if (!upperBackground && lowerBackground) line += `${ravenColor(upper)}▀\x1b[0m`;
    else if (upperBackground && !lowerBackground) line += `${ravenColor(lower)}▄\x1b[0m`;
    else line += `${ravenColor(upper)}${ravenColor(lower, true)}▀\x1b[0m`;
  }
  return line;
}).join("\n");

export function renderWorkflowRibbon(phase: number): string {
  const canvas = new BrailleCanvas(COLUMNS, ROWS);
  const filaments: Point[][] = Array.from({ length: 5 }, () => []);
  const samples = 56;
  const normalizedPhase = ((phase % TAU) + TAU) % TAU;

  for (let index = 0; index < samples; index++) {
    const t = index / (samples - 1);
    const angle = t * TAU;
    const center = 9.5
      + Math.sin(angle + normalizedPhase) * 4.1
      + Math.sin(angle * 2 - normalizedPhase * 2) * 1.25;
    const depth = Math.cos(angle + normalizedPhase);
    const halfWidth = 1.1 + (depth + 1) * 1.25;
    const x = 1.5 + t * 54;
    for (let filament = 0; filament < filaments.length; filament++) {
      const across = filament / (filaments.length - 1) * 2 - 1;
      const twist = Math.sin(angle * 1.5 + normalizedPhase + across * 1.2) * 0.45;
      filaments[filament]!.push({ x, y: center + across * halfWidth + twist });
    }
  }

  for (const filament of filaments) canvas.polyline(filament);
  return canvas.render();
}

export function createWorkflowRibbonFrames(frameCount = 48): readonly string[] {
  if (!Number.isInteger(frameCount) || frameCount <= 0 || frameCount > 60) {
    throw new RangeError("Animation frame count must be an integer from 1 to 60");
  }
  return Array.from({ length: frameCount }, (_, index) => renderWorkflowRibbon(index * TAU / frameCount));
}

export const WORKFLOW_RIBBON_PROJECT = createMotionProject({
  width: COLUMNS,
  height: ROWS,
  frameRate: 1000 / 140,
  durationFrames: 48,
  renderFrame: (frame) => renderWorkflowRibbon(frame * TAU / 48),
});

export const WORKFLOW_RIBBON_FRAMES = exportMotionFrames(WORKFLOW_RIBBON_PROJECT);

export const WORKFLOW_SIGNAL_PROJECT = createMotionSceneProject({
  width: COLUMNS,
  height: ROWS,
  frameRate: 6,
  durationFrames: 12,
  layers: [
    {
      cells: [
        { x: 4, y: 2, value: "+" },
        { x: 24, y: 2, value: "+" },
        { x: 14, y: 0, value: "|" },
        { x: 14, y: 4, value: "|" },
      ],
    },
    {
      renderFrame(frame) {
        const output = Array.from({ length: ROWS }, () => Array<string>(COLUMNS).fill(" "));
        const x = 7 + frame;
        output[2]![x] = frame % 2 === 0 ? "." : ":";
        return output.map((row) => row.join("")).join("\n");
      },
    },
  ],
});
