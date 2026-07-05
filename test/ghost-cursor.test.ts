import { describe, expect, it } from "vitest"
import {
  ghostCursorMouseActionExpression,
  ghostCursorRestoreExpression,
  inputDispatchMouseEventToGhostCursorAction,
} from "../src/ghost-cursor.ts"

describe("ghost cursor mouse actions", () => {
  it("maps supported mouse events and normalizes buttons", () => {
    expect(inputDispatchMouseEventToGhostCursorAction({ type: "mouseMoved", x: 12, y: 34 })).toEqual({
      type: "move",
      x: 12,
      y: 34,
      button: "none",
    })
    expect(inputDispatchMouseEventToGhostCursorAction({ type: "mousePressed", x: 12, y: 34, button: "left" })).toEqual({
      type: "down",
      x: 12,
      y: 34,
      button: "left",
    })
    expect(inputDispatchMouseEventToGhostCursorAction({ type: "mouseReleased", x: 12, y: 34, button: "unsupported" })).toEqual({
      type: "up",
      x: 12,
      y: 34,
      button: "none",
    })
  })

  it("ignores wheel, touch, unrelated, and malformed events", () => {
    expect(inputDispatchMouseEventToGhostCursorAction({ type: "mouseWheel", x: 1, y: 2 })).toBeUndefined()
    expect(inputDispatchMouseEventToGhostCursorAction({ type: "touchStart", x: 1, y: 2 })).toBeUndefined()
    expect(inputDispatchMouseEventToGhostCursorAction({ type: "keyDown", x: 1, y: 2 })).toBeUndefined()
    expect(inputDispatchMouseEventToGhostCursorAction({ type: "mouseMoved", x: "1", y: 2 })).toBeUndefined()
  })

  it("generates a bounded optional-runtime expression", () => {
    expect(ghostCursorMouseActionExpression({ type: "move", x: 12, y: 34, button: "none" })).toBe(
      'globalThis.__browserControlGhostCursor?.applyMouseEvent({"type":"move","x":12,"y":34,"button":"none"})',
    )
    expect(ghostCursorRestoreExpression({ x: 12, y: 34 })).toBe(
      'globalThis.__browserControlGhostCursor?.restore({"x":12,"y":34})',
    )
  })
})
