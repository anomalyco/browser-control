const unsupportedDirectorySyncCodes = new Set(["EPERM", "EINVAL", "ENOTSUP"])

export function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    unsupportedDirectorySyncCodes.has(error.code)
}
