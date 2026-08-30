import { describe, expect, it } from "vitest";
import {
  clampReach, clipPath, clipToHalfPlane, cornerPoint, foldGeometry, fullTurnReach,
  gradientAngle, gradientOffset, liftedCorner, type Point, type Rect
} from "./pageFold";

/** A square page, so every vertex a fold produces lands on a whole number. */
const PAGE: Rect = { left: 0, top: 0, right: 100, bottom: 100 };

const at = (x: number, y: number): Point => ({ x, y });
/** Outlines are compared as sets of rounded points: where a polygon starts is not part of its shape. */
const shape = (points: Point[]) =>
  points.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).sort();

describe("which corner a page is lifted by", () => {
  it("follows the half of the page the finger landed in", () => {
    expect(liftedCorner(PAGE, at(50, 10), "next")).toBe("top-right");
    expect(liftedCorner(PAGE, at(50, 90), "next")).toBe("bottom-right");
  });

  it("turns the right-hand corner to go forward and the left to go back, as a book does", () => {
    expect(liftedCorner(PAGE, at(50, 90), "next")).toBe("bottom-right");
    expect(liftedCorner(PAGE, at(50, 90), "previous")).toBe("bottom-left");
  });

  it("gives the halfway press to the bottom, so the tie falls the way a page is usually held", () => {
    expect(liftedCorner(PAGE, at(50, 50), "next")).toBe("bottom-right");
  });
});

describe("how far a corner can be carried", () => {
  it("refuses to push a corner outwards, which would take the day off the screen", () => {
    // Carried outwards the crease leaves the page, every part of it counts as folded, and there is
    // nothing left lying flat to look at.
    expect(clampReach("bottom-right", at(40, 0), 0.7).x).toBe(0);
    expect(clampReach("bottom-left", at(-40, 0), 0.7).x).toBe(0);
  });

  it("lets a corner travel inwards", () => {
    expect(clampReach("bottom-right", at(-40, 0), 0.7).x).toBe(-40);
    expect(clampReach("bottom-left", at(40, 0), 0.7).x).toBe(40);
  });

  it("holds the tilt within the sideways travel, so a turn never becomes a wipe", () => {
    // Straight up the page is a fold, but not a page being turned: ten pixels sideways buys seven
    // of tilt however far the finger actually slid.
    expect(clampReach("bottom-right", at(-10, -400), 0.7).y).toBeCloseTo(-7);
    expect(clampReach("bottom-right", at(-10, 400), 0.7).y).toBeCloseTo(7);
  });

  it("leaves a gentle tilt alone", () => {
    expect(clampReach("bottom-right", at(-100, -30), 0.7).y).toBe(-30);
  });

  it("keeps an unmoved corner where it is", () => {
    expect(clampReach("bottom-right", at(0, 0), 0.7)).toEqual({ x: 0, y: 0 });
  });
});

describe("the shape of a straight fold", () => {
  it("lands the corner exactly where it was carried", () => {
    // The whole figure is one reflection, so this single fact validates the construction: mirror
    // the corner back across the crease and it has to arrive at the finger.
    const dragged = at(37, 61);
    const fold = foldGeometry(PAGE, "bottom-right", dragged)!;
    const { at: creaseAt, normal } = fold.crease;
    const corner = cornerPoint(PAGE, "bottom-right");
    const beyond = 2 * ((corner.x - creaseAt.x) * normal.x + (corner.y - creaseAt.y) * normal.y);
    expect(corner.x - beyond * normal.x).toBeCloseTo(dragged.x);
    expect(corner.y - beyond * normal.y).toBeCloseTo(dragged.y);
  });

  it("lifts a triangle and leaves the rest of the page flat when the crease crosses two adjacent edges", () => {
    const fold = foldGeometry(PAGE, "bottom-right", at(60, 60))!;
    // The crease is x + y = 160, cutting off the bottom-right corner.
    expect(shape(fold.flat)).toEqual(shape([
      at(0, 0), at(100, 0), at(100, 60), at(60, 100), at(0, 100)
    ]));
    expect(shape(fold.flap)).toEqual(shape([at(100, 60), at(60, 60), at(60, 100)]));
  });

  it("leaves a quadrilateral either side when the crease crosses two opposite edges", () => {
    const fold = foldGeometry(PAGE, "bottom-right", at(40, 100))!;
    // Carried straight sideways, the crease stands vertical at x = 70.
    expect(shape(fold.flat)).toEqual(shape([at(0, 0), at(70, 0), at(70, 100), at(0, 100)]));
    expect(shape(fold.flap)).toEqual(shape([at(70, 0), at(40, 0), at(40, 100), at(70, 100)]));
  });

  it("turns the whole page once the corner is carried past the far edge", () => {
    const fold = foldGeometry(PAGE, "bottom-right", at(-300, 100))!;
    expect(fold.flat).toEqual([]);
    expect(fold.flap).toHaveLength(4);
  });

  it("folds a top corner the same way it folds a bottom one", () => {
    const fold = foldGeometry(PAGE, "top-right", at(60, 40))!;
    expect(shape(fold.flat)).toEqual(shape([
      at(0, 0), at(60, 0), at(100, 40), at(100, 100), at(0, 100)
    ]));
    expect(shape(fold.flap)).toEqual(shape([at(60, 0), at(60, 40), at(100, 40)]));
  });

  it("has no fold to draw when the corner has not moved", () => {
    expect(foldGeometry(PAGE, "bottom-right", cornerPoint(PAGE, "bottom-right"))).toBeUndefined();
    expect(foldGeometry(PAGE, "bottom-right", at(100 - 1e-12, 100))).toBeUndefined();
  });

  it("leaves nothing lying flat once the corner has reached its full turn", () => {
    const corner = cornerPoint(PAGE, "bottom-right");
    const reach = fullTurnReach(PAGE, "bottom-right", 0.7);
    const fold = foldGeometry(PAGE, "bottom-right", at(corner.x + reach.x * 2, corner.y + reach.y * 2))!;
    expect(fold.flat).toEqual([]);
  });
});

describe("clipping an outline", () => {
  it("keeps a vertex sitting exactly on the line once, not twice", () => {
    const square = [at(0, 0), at(100, 0), at(100, 100), at(0, 100)];
    // A vertical line straight through two corners of the square.
    const kept = clipToHalfPlane(square, at(0, 0), at(1, 0));
    expect(kept).toHaveLength(4);
  });

  it("has nothing to say about a shape that is not one", () => {
    expect(clipToHalfPlane([at(0, 0), at(1, 1)], at(0, 0), at(1, 0))).toEqual([]);
  });
});

describe("drawing the fold", () => {
  it("draws nothing rather than an empty polygon, which would be ignored as invalid", () => {
    expect(clipPath([])).toBe("");
    expect(clipPath([at(0, 0), at(1, 1)])).toBe("");
    expect(clipPath([at(0, 0), at(10, 0), at(0, 10)])).toBe("polygon(0.00px 0.00px, 10.00px 0.00px, 0.00px 10.00px)");
  });

  it("measures a screen direction as a CSS angle, clockwise from straight up", () => {
    expect(gradientAngle(at(0, -1))).toBeCloseTo(0);
    expect(gradientAngle(at(1, 0))).toBeCloseTo(90);
    expect(gradientAngle(at(0, 1))).toBeCloseTo(180);
    expect(gradientAngle(at(-1, 0))).toBeCloseTo(270);
    expect(gradientAngle(at(1, -1))).toBeCloseTo(45);
  });

  it("finds where a point falls along a gradient's own axis", () => {
    const box = { width: 200, height: 100 };
    // Left to right: the axis is the box's width, and x maps straight onto it.
    expect(gradientOffset(box, 90, at(0, 50))).toBeCloseTo(0);
    expect(gradientOffset(box, 90, at(200, 50))).toBeCloseTo(200);
    // Bottom to top: the axis is the box's height, and it runs against y.
    expect(gradientOffset(box, 0, at(100, 100))).toBeCloseTo(0);
    expect(gradientOffset(box, 0, at(100, 0))).toBeCloseTo(100);
  });
});
