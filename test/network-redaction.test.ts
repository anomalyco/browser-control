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

  it("preserves duplicate form fields and counts empty secret occurrences", () => {
    const collector = new SecretCollector()
    expect(collector.protectBody("token=&name=one&token=first&name=two&token=second", "application/x-www-form-urlencoded", "request", "POST /api"))
      .toBe("token=&name=one&token=${BC_SECRET_1}&name=two&token=${BC_SECRET_2}")
    expect(collector.slots()).toEqual([
      { ref: "BC_SECRET_1", value: "first", sources: ["POST /api.request.form.token.1"] },
      { ref: "BC_SECRET_2", value: "second", sources: ["POST /api.request.form.token.2"] },
    ])
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

  it("retains rotated values for output redaction without persisting history", () => {
    const collector = new SecretCollector([{ ref: "BC_SECRET_4", value: "old-token", sources: ["request.header.authorization"] }])
    for (const value of ["middle-token", "latest-token"]) {
      collector.protectHeaders([{ name: "Authorization", value: `Bearer ${value}` }], "request")
    }
    expect(collector.redactText("old-token middle-token latest-token ${BC_SECRET_4}"))
      .toBe("${BC_SECRET_4} ${BC_SECRET_4} ${BC_SECRET_4} ${BC_SECRET_4}")
    expect(collector.redactValue({ echoes: ["old-token", "middle-token", "latest-token"] }))
      .toEqual({ echoes: ["${BC_SECRET_4}", "${BC_SECRET_4}", "${BC_SECRET_4}"] })
    expect(collector.slots()).toEqual([{ ref: "BC_SECRET_4", value: "latest-token", sources: ["request.header.authorization"] }])
    expect(new SecretCollector(collector.slots()).redactText("old-token middle-token latest-token"))
      .toBe("old-token middle-token ${BC_SECRET_4}")
  })

  it.each(["https://example.com/callback", "/callback", "", "//example.com/callback"])("protects OAuth fragments in Location URLs: %s", (base) => {
    const collector = new SecretCollector()
    expect(collector.protectHeaders([{
      name: "Location",
      value: `${base}#access_token=first-token&id_token=second-token&access_token=third-token&label=a%20b&flag`,
    }], "response")).toEqual([{
      name: "Location",
      value: `${base}#access_token=\${BC_SECRET_1}&id_token=\${BC_SECRET_2}&access_token=\${BC_SECRET_3}&label=a%20b&flag`,
    }])
    expect(collector.slots().map((slot) => slot.sources)).toEqual([
      ["response.header.location.url.fragment.access_token"],
      ["response.header.location.url.fragment.id_token"],
      ["response.header.location.url.fragment.access_token.1"],
    ])
  })

  it("keeps query and fragment credential sources independent", () => {
    const collector = new SecretCollector()
    expect(collector.protectUrl("/callback?access_token=query-token#access_token=fragment-token"))
      .toBe("/callback?access_token=${BC_SECRET_1}#access_token=${BC_SECRET_2}")
    expect(collector.slots().map((slot) => slot.value)).toEqual(["query-token", "fragment-token"])
  })

  it.each(["#public%20anchor", "#tab=hello%20world&flag", "#/route?tab=public", "#section?access_token=public-text"])("preserves public fragments verbatim: %s", (fragment) => {
    const collector = new SecretCollector()
    expect(collector.protectUrl(`/callback${fragment}`)).toBe(`/callback${fragment}`)
    expect(collector.protectUrl(`https://example.com/callback${fragment}`)).toBe(`https://example.com/callback${fragment}`)
    expect(collector.slots()).toEqual([])
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

  it("redacts 4+ char substrings while keeping 1-char values from corrupting URLs", () => {
    expect(redactKnownValues("https://example.com/v1/dark-mode?limit=10", [
      { ref: "BC_SECRET_1", value: "1" },
      { ref: "BC_SECRET_2", value: "dark" },
    ])).toBe("https://example.com/v1/${BC_SECRET_2}-mode?limit=10")
  })

  it("does not rewrite stable placeholders during exact-value output redaction", () => {
    expect(redactKnownValues("${BC_SECRET_1}", [
      { ref: "BC_SECRET_2", value: "BC_SECRET_1" },
    ])).toBe("${BC_SECRET_1}")
  })

  it("redacts exact known values from command output", () => {
    expect(redactKnownValues("using secret-value twice secret-value", [
      { ref: "BC_SECRET_1", value: "secret-value" },
    ])).toBe("using ${BC_SECRET_1} twice ${BC_SECRET_1}")
  })

  it("combines known values and secret-shaped fields without changing nested scalar semantics", () => {
    const collector = new SecretCollector([
      { ref: "BC_SECRET_1", value: "known-token", sources: ["request.header.authorization"] },
      { ref: "BC_SECRET_2", value: "42", sources: ["request.body.pin"] },
      { ref: "BC_SECRET_3", value: "false", sources: ["request.body.flag"] },
    ])
    const input = {
      label: "prefix known-token ${BC_SECRET_1}",
      items: [42, false, null, "", { password: ["unknown", 42, false, null, "", { nested: "known-token" }] }],
      credentials: { empty: "", missing: null, flag: false, nested: [{ label: "not previously observed" }] },
      untouched: { value: "plain", count: 7 },
    }
    const original = structuredClone(input)

    expect(collector.redactValue(input)).toEqual({
      label: "prefix ${BC_SECRET_1} ${BC_SECRET_1}",
      items: ["${BC_SECRET_2}", "${BC_SECRET_3}", null, "", { password: ["[REDACTED]", "[REDACTED]", "[REDACTED]", null, "", { nested: "[REDACTED]" }] }],
      credentials: { empty: "", missing: null, flag: "[REDACTED]", nested: [{ label: "[REDACTED]" }] },
      untouched: { value: "plain", count: 7 },
    })
    expect(input).toEqual(original)
  })
})
