const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export class BrailleCanvas {
  readonly width: number;
  readonly height: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly #cells: Uint8Array;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError("Braille canvas dimensions must be positive integers");
    }
    this.width = width;
    this.height = height;
    this.pixelWidth = width * 2;
    this.pixelHeight = height * 4;
    this.#cells = new Uint8Array(width * height);
  }

  setPixel(x: number, y: number): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || px >= this.pixelWidth || py < 0 || py >= this.pixelHeight) return;
    const cell = Math.floor(py / 4) * this.width + Math.floor(px / 2);
    this.#cells[cell]! |= DOT_BITS[py % 4]![px % 2]!;
  }

  line(from: Point, to: Point): void {
    let x0 = Math.round(from.x);
    let y0 = Math.round(from.y);
    const x1 = Math.round(to.x);
    const y1 = Math.round(to.y);
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;

    for (;;) {
      this.setPixel(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const twiceError = error * 2;
      if (twiceError >= dy) {
        error += dy;
        x0 += sx;
      }
      if (twiceError <= dx) {
        error += dx;
        y0 += sy;
      }
    }
  }

  polyline(points: readonly Point[]): void {
    for (let index = 1; index < points.length; index++) {
      this.line(points[index - 1]!, points[index]!);
    }
  }

  render(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = "";
      for (let x = 0; x < this.width; x++) {
        row += String.fromCodePoint(0x2800 + this.#cells[y * this.width + x]!);
      }
      rows.push(row);
    }
    return rows.join("\n");
  }
}
