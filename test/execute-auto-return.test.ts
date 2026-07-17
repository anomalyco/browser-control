import { describe, expect, it } from "vitest"
import { getAutoReturnExpression, wrapCode } from "../src/execute.ts"

describe("getAutoReturnExpression", () => {
  it("returns single expressions", () => {
    expect(getAutoReturnExpression("page.url()")).toBe("page.url()")
    expect(getAutoReturnExpression("await page.title()")).toBe("await page.title()")
    expect(getAutoReturnExpression("1 + 2")).toBe("1 + 2")
  })

  it("ignores multi-statement snippets", () => {
    expect(getAutoReturnExpression("const a = 1; a")).toBeNull()
    expect(getAutoReturnExpression("page.url(); page.title()")).toBeNull()
  })

  it("ignores assignments and updates", () => {
    expect(getAutoReturnExpression("state.count = 1")).toBeNull()
    expect(getAutoReturnExpression("state.count += 1")).toBeNull()
    expect(getAutoReturnExpression("count++")).toBeNull()
    expect(getAutoReturnExpression("delete state.count")).toBeNull()
  })

  it("ignores sequence expressions containing assignments", () => {
    expect(getAutoReturnExpression("(state.a = 1, state.a)")).toBeNull()
  })

  it("ignores explicit returns and declarations", () => {
    expect(getAutoReturnExpression("return page.url()")).toBeNull()
    expect(getAutoReturnExpression("const a = 1")).toBeNull()
  })

  it("returns null for unparseable code", () => {
    expect(getAutoReturnExpression("const = ]")).toBeNull()
  })
})

describe("wrapCode", () => {
  it("wraps single expressions in return await", () => {
    expect(wrapCode("page.url()")).toBe("return await (page.url())")
  })

  it("leaves statements untouched", () => {
    const code = "const a = 1\nreturn a"
    expect(wrapCode(code)).toBe(code)
  })

})
