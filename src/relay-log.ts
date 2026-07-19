import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const maxLogBytes = 1_000_000
const maxEntryCharacters = 64_000

export function managedRelayLogPath(home = os.homedir()): string {
  return path.join(home, ".browser-control", "relay.log")
}

export function appendManagedRelayProcessLog(message: string, home = os.homedir()): void {
  try {
    const logPath = managedRelayLogPath(home)
    const directory = path.dirname(logPath)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    const entry = `${new Date().toISOString()} ${message.slice(0, maxEntryCharacters)}\n`
    const stat = fs.statSync(logPath, { throwIfNoEntry: false })
    if (stat && stat.size + Buffer.byteLength(entry) > maxLogBytes) fs.truncateSync(logPath, 0)
    fs.appendFileSync(logPath, entry, { encoding: "utf8", mode: 0o600 })
    fs.chmodSync(logPath, 0o600)
  } catch {
    // Process-fault logging must never hide or replace the original fault.
  }
}
