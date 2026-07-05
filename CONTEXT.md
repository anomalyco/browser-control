---
title: Browser Control Context
description: Domain language for the standalone browser-control project.
prompt: |
  Create a planning folder for a standalone browser-control project. Capture
  the decisions from a design discussion where the product is a trusted driver
  for agents to control the user's already-running Chromium-family browser via
  a Chrome extension, loose attached-tab semantics, code-first execution,
  persistent sandboxes, stock Playwright for v1, and no built-in LLM agent.
---

# Browser Control

Browser Control is a local browser driver for agents. It lets trusted agents
operate the user's visible Chromium-family browser through an installed
extension and a local bridge.

## Language

**Driver**:
A deterministic browser-control layer that executes requests from an external
agent without planning or calling a model.
_Avoid_: Agent, autonomous agent, LLM runner

**Agent**:
An external client that decides what browser work to perform and calls Browser
Control to execute it.
_Avoid_: Driver

**User Browser**:
The user's already-running Chromium-family browser with the Browser Control
extension installed.
_Avoid_: Chrome-only, managed browser

**Attached Tab**:
A browser tab whose debugger connection is active and therefore visible and
controllable by agents.
_Avoid_: Owned tab, session tab

**Attached-Tab Pool**:
The shared set of attached tabs exposed to all connected agent sessions.
_Avoid_: Workspace, isolated browser context

**Detach**:
The act of releasing debugger access for an attached tab without closing the
tab.
_Avoid_: Close, delete, revoke session

**Toolbar Control**:
The browser extension action surface used to attach, detach, and display status
for the active tab.
_Avoid_: Side panel, chat panel

**Execute Sandbox**:
A persistent trusted JavaScript environment where an agent runs browser
automation code.
_Avoid_: Security sandbox, permission boundary

**Persistent State**:
The per-session `state` object that survives across multiple execute calls.
_Avoid_: Browser storage, tab state

**MCP Process Session**:
The implicit persistent execute sandbox owned by one running MCP server process.
_Avoid_: Explicit MCP session id

## Relationships

- A **Driver** serves one or more external **Agents**.
- A **User Browser** contains zero or more **Attached Tabs**.
- The **Attached-Tab Pool** is shared across sessions in v1.
- A **Toolbar Control** attaches or detaches the active tab.
- An **Attached-Tab Group** makes the **Attached-Tab Pool** visible to the user.
- An **Agent** controls the browser by running code in an **Execute Sandbox**.
- An **Execute Sandbox** owns **Persistent State**, not browser tabs.
- **Detach** removes an **Attached Tab** from the **Attached-Tab Pool**.

## Example Dialogue

> **Dev:** "If an agent starts and no tabs are attached, does it need the user
> to open a page first?"
> **Domain expert:** "No. It may create an initial tab, but it still operates
> through the user's installed browser extension."

> **Dev:** "Are tabs private to one agent session?"
> **Domain expert:** "No. v1 uses a loose attached-tab pool. Sessions keep
> separate JavaScript state, but attached tabs are shared."

## Flagged Ambiguities

- "Chrome" means **User Browser** unless browser-specific behavior is being
  discussed. Browser Control should support Chromium-family browsers such as
  Brave, Chrome, Edge, Chromium, and Vivaldi.
- "Sandbox" means **Execute Sandbox** for persistence and convenience; it is
  not a hard security boundary against untrusted code.
