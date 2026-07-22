import { createClientTargetAnnouncements, type ClientCdpSessionAlias, type ClientTargetAnnouncements } from "./cdp-shims.ts"
import type { JsonObject } from "./protocol.ts"
import type { ChildTarget, ConnectedTarget } from "./relay-types.ts"

type CdpClientState = {
  readonly aliases: Map<string, ClientCdpSessionAlias>
  readonly announcements: ClientTargetAnnouncements
  readonly browserControlSessionId?: string
  autoAttachParams?: JsonObject
}

export class CdpClientPool<Client extends object> implements Iterable<Client> {
  private readonly states = new Map<Client, CdpClientState>()
  private nextAliasId = 1
  private connectionGeneration = 0

  register(client: Client, browserControlSessionId?: string): void {
    if (this.states.has(client)) throw new Error("CDP client is already registered")
    this.states.set(client, {
      aliases: new Map(),
      announcements: createClientTargetAnnouncements(),
      ...(browserControlSessionId ? { browserControlSessionId } : {}),
    })
    this.connectionGeneration += 1
  }

  unregister(client: Client): number | undefined {
    if (!this.states.delete(client) || this.states.size !== 0) return undefined
    return ++this.connectionGeneration
  }

  get size(): number {
    return this.states.size
  }

  [Symbol.iterator](): IterableIterator<Client> {
    return this.states.keys()
  }

  sessionId(client: Client): string | undefined {
    return this.states.get(client)?.browserControlSessionId
  }

  announcements(client: Client): ClientTargetAnnouncements {
    return this.requireState(client).announcements
  }

  setAutoAttachParams(client: Client, params: JsonObject | undefined): void {
    const state = this.requireState(client)
    if (params === undefined) delete state.autoAttachParams
    else state.autoAttachParams = params
  }

  autoAttachParams(client: Client): JsonObject | undefined {
    return this.states.get(client)?.autoAttachParams
  }

  isCurrentIdleGeneration(generation: number): boolean {
    return this.states.size === 0 && this.connectionGeneration === generation
  }

  createBrowserAlias(client: Client): string {
    const aliasId = this.nextAlias("browser")
    this.requireState(client).aliases.set(aliasId, { kind: "browser" })
    return aliasId
  }

  createTargetAlias(client: Client, target: ConnectedTarget | ChildTarget, rootSessionId: string | undefined): string {
    const aliasId = this.nextAlias("session")
    this.requireState(client).aliases.set(aliasId, {
      kind: "target",
      tabId: target.tabId,
      targetId: target.targetInfo.targetId,
      ...(target.sessionId === rootSessionId ? {} : { chromeSessionId: target.sessionId }),
    })
    return aliasId
  }

  alias(client: Client, aliasId: string): ClientCdpSessionAlias | undefined {
    return this.states.get(client)?.aliases.get(aliasId)
  }

  deleteAlias(client: Client, aliasId: string): boolean {
    return this.states.get(client)?.aliases.delete(aliasId) ?? false
  }

  removeTargetAliases(matches: (alias: Extract<ClientCdpSessionAlias, { readonly kind: "target" }>) => boolean): void {
    for (const state of this.states.values()) {
      removeTargetAliases(state, matches)
    }
  }

  removeClientTargetAliases(client: Client, matches: (alias: Extract<ClientCdpSessionAlias, { readonly kind: "target" }>) => boolean): void {
    removeTargetAliases(this.requireState(client), matches)
  }

  private nextAlias(kind: "browser" | "session"): string {
    return `bc-client-${kind}-${this.nextAliasId++}`
  }

  private requireState(client: Client): CdpClientState {
    const state = this.states.get(client)
    if (!state) throw new Error("CDP client is not registered")
    return state
  }
}

function removeTargetAliases(
  state: CdpClientState,
  matches: (alias: Extract<ClientCdpSessionAlias, { readonly kind: "target" }>) => boolean,
): void {
  for (const [aliasId, alias] of state.aliases) {
    if (alias.kind === "target" && matches(alias)) state.aliases.delete(aliasId)
  }
}
