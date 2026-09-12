export function double(value: number): number {
  return value * 2;
}

export class Calculator {
  triple(value: number): number {
    return value * 3;
  }
}

export function calculate(value: number): number {
  return double(value);
}
