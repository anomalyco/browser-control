import { describe, expect, it } from "vitest"
import { redactKnownValues, SecretCollector } from "../src/network-redaction.ts"

describe("SecretCollector", () => {
  it("preserves credential placement while deduplicating values", () => {
    const collector = new SecretCollector()
    const headers = collector.protectHeaders([
      { name: "Authorization", value: "Bearer token-value" },
      { name: "Cookie", value: "session=cookie-value; theme=dark" },
      { name: "X-CSRF-Token", value: "token-value" },
      { name: "Accept", value: "application/json" },
    ], "request")

    expect(headers).toEqual([
      { name: "Authorization", value: "Bearer ${BC_SECRET_1}" },
      { name: "Cookie", value: "session=${BC_SECRET_2}; theme=${BC_SECRET_3}" },
      { name: "X-CSRF-Token", value: "${BC_SECRET_1}" },
      { name: "Accept", value: "application/json" },
    ])
    expect(collector.slots()).toEqual([
      expect.objectContaining({ ref: "BC_SECRET_1", value: "token-value" }),
      expect.objectContaining({ ref: "BC_SECRET_2", value: "cookie-value" }),
      expect.objectContaining({ ref: "BC_SECRET_3", value: "dark" }),
    ])
  })

  it("redacts token-like URL and JSON fields", () => {
    const collector = new SecretCollector()
    const url = collector.protectUrl("https://example.com/api?access_token=abc&limit=10")
    const body = collector.protectBody(JSON.stringify({ user: "kit", nested: { refreshToken: "def" } }), "application/json", "response")

    expect(url).toBe("https://example.com/api?access_token=${BC_SECRET_1}&limit=10")
    expect(JSON.parse(body!)).toEqual({ user: "kit", nested: { refreshToken: "${BC_SECRET_2}" } })
  })

  it("redacts numeric and collection credentials in JSON", () => {
    const collector = new SecretCollector()
    const body = collector.protectBody(JSON.stringify({ otp: 123456, tokens: ["first-token", "second-token"] }), "application/json", "response")

    expect(JSON.parse(body!)).toEqual({
      otp: "${BC_SECRET_1}",
      tokens: ["${BC_SECRET_2}", "${BC_SECRET_3}"],
    })
    expect(collector.slots().map((slot) => slot.value)).toEqual(["123456", "first-token", "second-token"])
  })

  it("keeps references literal in form bodies", () => {
    const collector = new SecretCollector()
    expect(collector.protectBody("csrf_token=abc&name=kit", "application/x-www-form-urlencoded", "request"))
      .toBe("csrf_token=${BC_SECRET_1}&name=kit")
  })

  it("redacts multipart credential fields and preserves their placement", () => {
    const collector = new SecretCollector()
    const body = [
      "--boundary",
      'Content-Disposition: form-data; name="username"',
      "",
      "kit",
      "--boundary",
      'Content-Disposition: form-data; name="password"',
      "",
      "secret-password",
      "--boundary--",
      "",
    ].join("\r\n")
    expect(collector.protectBody(body, "multipart/form-data; boundary=boundary", "request"))
      .toBe(body.replace("secret-password", "${BC_SECRET_1}"))
    expect(collector.slots()).toEqual([
      expect.objectContaining({ ref: "BC_SECRET_1", value: "secret-password" }),
    ])
  })

  it("omits multipart bodies containing file parts", () => {
    const collector = new SecretCollector()
    const body = [
      "--boundary",
      'Content-Disposition: form-data; name="upload"; filename="secret.txt"',
      "Content-Type: text/plain",
      "",
      "opaque content",
      "--boundary--",
      "",
    ].join("\r\n")
    expect(collector.protectBody(body, "multipart/form-data; boundary=boundary", "request")).toBeUndefined()
  })

  it("updates stable refs by source during refresh", () => {
    const collector = new SecretCollector([{ ref: "BC_SECRET_4", value: "old", sources: ["request.header.authorization"] }])
    expect(collector.protectHeaders([{ name: "Authorization", value: "Bearer new" }], "request")).toEqual([
      { name: "Authorization", value: "Bearer ${BC_SECRET_4}" },
    ])
    expect(collector.slots()[0]).toMatchObject({ ref: "BC_SECRET_4", value: "new" })
    expect(collector.updatedRefs()).toEqual(["BC_SECRET_4"])
    expect(collector.observedRefs()).toEqual(["BC_SECRET_4"])
  })

  it("reports an unchanged credential as observed but not updated", () => {
    const collector = new SecretCollector([{ ref: "BC_SECRET_1", value: "same", sources: ["request.header.authorization"] }])
    collector.protectHeaders([{ name: "Authorization", value: "Bearer same" }], "request")
    expect(collector.observedRefs()).toEqual(["BC_SECRET_1"])
    expect(collector.updatedRefs()).toEqual([])
  })

  it("keeps credentials from different request sources independent", () => {
    const collector = new SecretCollector()
    const first = collector.protectHeaders([{ name: "Authorization", value: "Bearer first" }], "request", "GET https://one.example/api")
    const second = collector.protectHeaders([{ name: "Authorization", value: "Bearer second" }], "request", "GET https://two.example/api")
    expect(first[0]?.value).toBe("Bearer ${BC_SECRET_1}")
    expect(second[0]?.value).toBe("Bearer ${BC_SECRET_2}")
  })

  it("splits shared refs when one source rotates", () => {
    const collector = new SecretCollector([{
      ref: "BC_SECRET_1",
      value: "shared",
      sources: ["GET https://one.example/api.request.header.authorization", "GET https://two.example/api.request.header.authorization"],
    }])
    const protectedHeaders = collector.protectHeaders(
      [{ name: "Authorization", value: "Bearer rotated" }],
      "request",
      "GET https://one.example/api",
    )
    expect(protectedHeaders[0]?.value).toBe("Bearer ${BC_SECRET_2}")
    expect(collector.slots()).toEqual([
      expect.objectContaining({ ref: "BC_SECRET_1", value: "shared", sources: ["GET https://two.example/api.request.header.authorization"] }),
      expect.objectContaining({ ref: "BC_SECRET_2", value: "rotated", sources: ["GET https://one.example/api.request.header.authorization"] }),
    ])
  })

  it("preserves duplicate query parameters while redacting each occurrence", () => {
    const collector = new SecretCollector()
    expect(collector.protectUrl("https://example.com/api?token=first&token=second"))
      .toBe("https://example.com/api?token=${BC_SECRET_1}&token=${BC_SECRET_2}")
  })

  it("redacts token-like parameters in relative redirect URLs", () => {
    const collector = new SecretCollector()
    expect(collector.protectHeaders([{ name: "Location", value: "/callback?code=secret#done" }], "response"))
      .toEqual([{ name: "Location", value: "/callback?code=${BC_SECRET_1}#done" }])
  })

  it("preserves duplicate cookie names as independent references", () => {
    const collector = new SecretCollector()
    expect(collector.protectHeaders([{ name: "Cookie", value: "sid=first; sid=second" }], "request"))
      .toEqual([{ name: "Cookie", value: "sid=${BC_SECRET_1}; sid=${BC_SECRET_2}" }])
  })

  it("redacts short exact values from command and execute output", () => {
    expect(redactKnownValues("https://example.com/v1/dark-mode?limit=10", [
      { ref: "BC_SECRET_1", value: "1", sources: ["cookie.limit"] },
      { ref: "BC_SECRET_2", value: "dark", sources: ["cookie.theme"] },
    ])).toBe("https://example.com/v${BC_SECRET_1}/${BC_SECRET_2}-mode?limit=${BC_SECRET_1}0")
  })

  it("does not rewrite stable placeholders during exact-value output redaction", () => {
    expect(redactKnownValues("${BC_SECRET_1}", [
      { ref: "BC_SECRET_2", value: "BC_SECRET_1", sources: ["request.header.authorization"] },
    ])).toBe("${BC_SECRET_1}")
  })

  it("redacts exact known values from command output", () => {
    expect(redactKnownValues("using secret-value twice secret-value", [
      { ref: "BC_SECRET_1", value: "secret-value", sources: [] },
    ])).toBe("using ${BC_SECRET_1} twice ${BC_SECRET_1}")
  })
})
