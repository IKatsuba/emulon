export interface Interval {
  start: number;
  end: number;
}

export function overlaps(left: Interval, right: Interval): boolean {
  return left.start < right.end && right.start < left.end;
}

export function isFree(
  interval: Interval,
  occupied: readonly Interval[],
): boolean {
  return !occupied.some((other) => overlaps(interval, other));
}
