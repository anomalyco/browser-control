import { describe, expect, it } from "vitest"
import {
  extensionProtocolCompatibility,
  extensionProtocolVersion,
  isCdpRequest,
  isExtensionEvent,
  isExtensionResponse,
  parseExtensionCommand,
  parseJsonObject,
} from "../src/protocol.ts"

describe("protocol validation", () => {
  it("accepts a valid extension command", () => {
    expect(parseExtensionCommand(JSON.stringify({
      id: 1,
      method: "debugger.sendCommand",
      params: { tabId: 7, method: "Runtime.evaluate" },
    }))).toMatchObject({ id: 1, method: "debugger.sendCommand" })
  })

  it("rejects unknown extension commands and invalid params", () => {
    expect(() => parseExtensionCommand(JSON.stringify({ id: 1, method: "unknown" }))).toThrow("Invalid extension command")
    expect(() => parseExtensionCommand(JSON.stringify({ id: 1, method: "ping", params: [] }))).toThrow("Invalid extension command")
  })

  it("validates CDP and extension message envelopes", () => {
    expect(isCdpRequest(parseJsonObject('{"id":1,"method":"Runtime.enable","params":{}}'))).toBe(true)
    expect(isCdpRequest(parseJsonObject('{"id":1,"method":"Runtime.enable","params":[]}'))).toBe(false)
    expect(isExtensionResponse(parseJsonObject('{"id":1,"result":{}}'))).toBe(true)
    expect(isExtensionResponse(parseJsonObject('{"id":1,"error":7}'))).toBe(false)
    expect(isExtensionResponse(parseJsonObject('{"id":1,"result":{},"error":"ambiguous"}'))).toBe(false)
    expect(isExtensionEvent(parseJsonObject('{"method":"toolbar.clicked","params":{"tabId":7}}'))).toBe(true)
    expect(isExtensionEvent(parseJsonObject('{"method":"unknown"}'))).toBe(false)
  })

  it("rejects legacy hellos and unknown protocol versions", () => {
    expect(extensionProtocolCompatibility(undefined)).toEqual({
      version: 1,
      compatible: false,
      legacy: true,
    })
    expect(extensionProtocolCompatibility(extensionProtocolVersion)).toEqual({
      version: extensionProtocolVersion,
      compatible: true,
      legacy: false,
    })
    expect(extensionProtocolCompatibility(extensionProtocolVersion + 1)).toMatchObject({ compatible: false, legacy: false })
    expect(extensionProtocolCompatibility("invalid")).toEqual({ version: null, compatible: false, legacy: false })
    expect(extensionProtocolCompatibility(null)).toEqual({ version: null, compatible: false, legacy: false })
    expect(extensionProtocolCompatibility(1.5)).toEqual({ version: null, compatible: false, legacy: false })
    expect(extensionProtocolCompatibility(-1)).toEqual({ version: null, compatible: false, legacy: false })
    expect(extensionProtocolCompatibility({})).toEqual({ version: null, compatible: false, legacy: false })
  })
})
