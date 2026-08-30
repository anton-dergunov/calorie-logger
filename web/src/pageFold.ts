/**
 * The shape of a page being turned by one corner.
 *
 * Nothing here knows about the DOM or about time. Given a page and the point a corner has been
 * carried to, it answers what is still lying flat and what has been lifted, which is everything the
 * gesture needs to draw and everything worth testing.
 *
 * The model is the one a real sheet of paper obeys. Fold a corner over to somewhere else on the
 * page and the crease falls exactly halfway between where the corner was and where it now is, at
 * right angles to the line between them; the paper beyond that crease is the same paper, mirrored.
 * So one reflection defines the whole figure, and the corner landing precisely where it was carried
 * is the proof that it is right.
 */

export interface Point { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number }

export type FoldCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type Towards = "next" | "previous";

/** Vertices closer to the crease than this are on it, and are kept once rather than twice. */
const ON_THE_LINE = 1e-9;

export function cornerPoint(page: Rect, corner: FoldCorner): Point {
  const right = corner === "top-right" || corner === "bottom-right";
  const bottom = corner === "bottom-left" || corner === "bottom-right";
  return { x: right ? page.right : page.left, y: bottom ? page.bottom : page.top };
}

/**
 * Which corner a press lifts: the half of the page the finger landed in decides top or bottom, and
 * the way it is going decides left or right. Forward turns the right-hand corner, as a book does.
 */
export function liftedCorner(page: Rect, press: Point, towards: Towards): FoldCorner {
  const side = towards === "next" ? "right" : "left";
  const half = press.y < (page.top + page.bottom) / 2 ? "top" : "bottom";
  return `${half}-${side}` as FoldCorner;
}

/**
 * How far the corner may actually be carried.
 *
 * Both limits are load-bearing rather than tidiness. A corner pushed *outward* puts the whole page
 * on the folded side, which empties the flat part and takes the day off the screen altogether. And
 * a corner carried steeply enough turns the crease horizontal, so the page is wiped up from the
 * bottom rather than turned sideways -- the direction test that starts the gesture is only asked
 * once, so nothing else stops the finger sliding vertically afterwards.
 */
export function clampReach(corner: FoldCorner, delta: Point, tilt: number): Point {
  const inward = corner === "top-right" || corner === "bottom-right"
    ? Math.min(0, delta.x)
    : Math.max(0, delta.x);
  const room = Math.abs(inward) * tilt;
  return { x: inward, y: Math.max(-room, Math.min(room, delta.y)) };
}

/**
 * The part of a convex polygon on the positive side of a line, by Sutherland and Hodgman. Pass a
 * negated normal for the other side.
 */
export function clipToHalfPlane(points: Point[], at: Point, normal: Point): Point[] {
  if (points.length < 3) return [];
  const side = (p: Point) => (p.x - at.x) * normal.x + (p.y - at.y) * normal.y;
  const kept: Point[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    const fromSide = side(from);
    const toSide = side(to);
    if (fromSide >= -ON_THE_LINE) kept.push(from);
    // One of the two ends is outside, so the edge crosses and the crossing point joins the outline.
    if ((fromSide > ON_THE_LINE && toSide < -ON_THE_LINE) || (fromSide < -ON_THE_LINE && toSide > ON_THE_LINE)) {
      const at = fromSide / (fromSide - toSide);
      kept.push({ x: from.x + (to.x - from.x) * at, y: from.y + (to.y - from.y) * at });
    }
  }
  return kept;
}

export interface Fold {
  /** The page still lying flat. Empty once the crease has passed the far edge. */
  flat: Point[];
  /** The lifted part, already mirrored: the shape actually drawn. */
  flap: Point[];
  /** What the lifted part has uncovered, which is where the sheet below shows through. */
  under: Point[];
  /** A point on the crease, and the unit normal pointing from it into the flap. */
  crease: { at: Point; normal: Point };
}

/**
 * Undefined when the corner has not actually been carried anywhere.
 *
 * `underlap` widens the uncovered part past the crease. The sheet below and the flap meet along
 * that line, and two independently antialiased edges meeting exactly on it add up to less than full
 * cover: a half-pixel of overlap is the difference between a fold and a fold with a seam down it.
 */
export function foldGeometry(page: Rect, corner: FoldCorner, dragged: Point, underlap = 0): Fold | undefined {
  const from = cornerPoint(page, corner);
  const axis = { x: dragged.x - from.x, y: dragged.y - from.y };
  const reach = Math.hypot(axis.x, axis.y);
  if (reach <= ON_THE_LINE) return undefined;

  const normal = { x: axis.x / reach, y: axis.y / reach };
  const at = { x: (from.x + dragged.x) / 2, y: (from.y + dragged.y) / 2 };
  const outline = [
    { x: page.left, y: page.top }, { x: page.right, y: page.top },
    { x: page.right, y: page.bottom }, { x: page.left, y: page.bottom }
  ];

  const away = { x: -normal.x, y: -normal.y };
  const flat = clipToHalfPlane(outline, at, normal);
  const lifted = clipToHalfPlane(outline, at, away);
  const under = underlap === 0 ? lifted
    : clipToHalfPlane(outline, { x: at.x + normal.x * underlap, y: at.y + normal.y * underlap }, away);
  const mirror = (p: Point): Point => {
    const beyond = 2 * ((p.x - at.x) * normal.x + (p.y - at.y) * normal.y);
    return { x: p.x - beyond * normal.x, y: p.y - beyond * normal.y };
  };
  return { flat, flap: lifted.map(mirror), under, crease: { at, normal } };
}

/** Where the corner has to reach for every last part of the page to be on the folded side. */
export function fullTurnReach(page: Rect, corner: FoldCorner, tilt: number): Point {
  const from = cornerPoint(page, corner);
  const width = page.right - page.left;
  const height = page.bottom - page.top;
  // The crease's foot travels with the corner at half its reach, so carrying the corner twice the
  // page's diagonal leaves the crease well past the furthest corner whatever the tilt.
  const span = Math.hypot(width, height) * 2;
  const sideways = corner === "top-right" || corner === "bottom-right" ? -span : span;
  return clampReach(corner, { x: sideways, y: from.y === page.top ? span : -span }, tilt);
}

/** A `polygon()`, or nothing at all: `polygon()` with no points is invalid and would be ignored. */
export function clipPath(points: Point[]): string {
  if (points.length < 3) return "";
  return `polygon(${points.map((p) => `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`).join(", ")})`;
}

/** The CSS angle of a screen direction. Zero is up, and the angle turns clockwise. */
export function gradientAngle(direction: Point): number {
  const degrees = Math.atan2(direction.x, -direction.y) * 180 / Math.PI;
  return (degrees + 360) % 360;
}

/**
 * How far along its own axis a gradient at this angle reaches the given point, in pixels from where
 * the gradient starts. A gradient begins at a corner of its box rather than at the crease, so a
 * highlight meant to sit on the crease has to be placed by measurement rather than guessed at.
 */
export function gradientOffset(box: { width: number; height: number }, angleDeg: number, point: Point): number {
  const radians = angleDeg * Math.PI / 180;
  const along = { x: Math.sin(radians), y: -Math.cos(radians) };
  const length = Math.abs(box.width * along.x) + Math.abs(box.height * along.y);
  const centre = { x: box.width / 2, y: box.height / 2 };
  return (point.x - centre.x) * along.x + (point.y - centre.y) * along.y + length / 2;
}
