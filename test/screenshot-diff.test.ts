import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PNG } from "pngjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createScreenshotDiff } from "../src/screenshot-diff.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

function image(width = 2, height = 2, red = 255): Buffer {
  const png = new PNG({ width, height })
  png.data.fill(255)
  png.data[0] = red
  return PNG.sync.write(png)
}

describe("screenshotDiff", () => {
  it("returns a PNG and exact zero-change metrics for equal images", async () => {
    const baseline = image()
    const screenshot = vi.fn(async () => baseline)
    const result = await createScreenshotDiff({ screenshot })({ baseline })
    expect(screenshot).toHaveBeenCalledWith({ type: "png", scale: "css", fullPage: false })
    expect(result).toMatchObject({ matches: true, width: 2, height: 2, changedPixels: 0, totalPixels: 4, changedRatio: 0, threshold: 0.1 })
    expect(PNG.sync.read(result.image!).width).toBe(2)
  })

  it("highlights changes in red and reports the changed fraction", async () => {
    const result = await createScreenshotDiff({ screenshot: async () => image(2, 2, 0) })({ baseline: image(), threshold: 0, fullPage: true })
    expect(result).toMatchObject({ matches: false, changedPixels: 1, totalPixels: 4, changedRatio: 0.25 })
    expect([...PNG.sync.read(result.image!).data.subarray(0, 4)]).toEqual([255, 0, 0, 255])
  })

  it("applies a color threshold rather than a changed-area allowance", async () => {
    const diff = createScreenshotDiff({ screenshot: async () => image(2, 2, 254) })
    expect((await diff({ baseline: image(), threshold: 0 })).changedPixels).toBe(1)
    expect((await diff({ baseline: image(), threshold: 0.1 })).changedPixels).toBe(0)
  })

  it("rejects differing dimensions without resizing", async () => {
    await expect(createScreenshotDiff({ screenshot: async () => image(3, 2) })({ baseline: image() })).rejects.toThrow("baseline 2×2, current 3×2")
  })

  it.each([-1, 1.1, NaN, Infinity])("rejects threshold %s before taking a screenshot", async (threshold) => {
    const screenshot = vi.fn(async () => image())
    await expect(createScreenshotDiff({ screenshot })({ baseline: image(), threshold })).rejects.toThrow("threshold")
    expect(screenshot).not.toHaveBeenCalled()
  })

  it("rejects corrupt and oversized PNGs before taking a screenshot", async () => {
    const screenshot = vi.fn(async () => image())
    const oversized = image()
    oversized.writeUInt32BE(100_000, 16)
    oversized.writeUInt32BE(100_000, 20)
    await expect(createScreenshotDiff({ screenshot })({ baseline: oversized })).rejects.toThrow("megapixel")
    await expect(createScreenshotDiff({ screenshot })({ baseline: Buffer.from("not a PNG") })).rejects.toThrow("PNG")
    const corrupt = image().subarray(0, 26)
    await expect(createScreenshotDiff({ screenshot })({ baseline: corrupt })).rejects.toThrow()
    expect(screenshot).not.toHaveBeenCalled()
  })

  it("reads a saved baseline and writes a private diff without overwriting either artifact", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "screenshot-diff-"))
    directories.push(directory)
    const baseline = path.join(directory, "before.png")
    const output = path.join(directory, "diff.png")
    const before = image()
    await fs.writeFile(baseline, before)
    const diff = createScreenshotDiff({ screenshot: async () => image(2, 2, 0) })
    const result = await diff({ baseline, path: output })
    expect(result).toMatchObject({ path: output, changedPixels: 1 })
    expect(result.image).toBeUndefined()
    expect((await fs.stat(output)).mode & 0o777).toBe(0o600)
    expect(PNG.sync.read(await fs.readFile(output)).width).toBe(2)
    await expect(diff({ baseline, path: baseline })).rejects.toThrow("EEXIST")
    await expect(diff({ baseline, path: output })).rejects.toThrow("EEXIST")
    expect(await fs.readFile(baseline)).toEqual(before)
  })

  it("requires absolute baseline and PNG output paths", async () => {
    const screenshot = vi.fn(async () => image())
    const diff = createScreenshotDiff({ screenshot })
    await expect(diff({ baseline: "before.png" })).rejects.toThrow("absolute")
    await expect(diff({ baseline: image(), path: "diff.png" })).rejects.toThrow("absolute")
    await expect(diff({ baseline: image(), path: "/tmp/diff.jpg" })).rejects.toThrow(".png")
    expect(screenshot).not.toHaveBeenCalled()
  })
})
