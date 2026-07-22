export function resolveExplicitSessionSelector(options: {
  readonly positional: string | undefined
  readonly flag: string | undefined
  readonly environment: string | undefined
}): string | undefined {
  if (options.positional && options.flag) {
    throw new Error("Use either a positional session id or --session, not both")
  }
  return options.flag ?? options.positional ?? options.environment
}
