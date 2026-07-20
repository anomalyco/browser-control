# Chrome Web Store Submission

This document is the source copy for the Browser Control Chrome Web Store
listing and review questionnaire. The initial distribution should be
**unlisted**.

## Single Purpose

Connect user-authorized local browser automation programs to controlled tabs in
the user's existing Chromium browser.

## Short Description

Connect controlled browser tabs to the local Browser Control driver for
user-authorized automation.

## Detailed Description

When enabled, trusted local programs can read and modify controlled pages, use
their signed-in state, create and close tabs, capture matching page network
activity, and record a controlled tab when requested. Data is sent only to the
Browser Control driver on this computer at `127.0.0.1:19989`; Anomaly does not
operate a Browser Control cloud relay.

Browser Control lets trusted agents and programs running on your computer
control tabs in your existing browser. It uses a local Node driver for
Playwright execution and a small extension adapter for Chrome debugging APIs.

The extension connects only to `127.0.0.1:19989`. Browser data is not sent to a
Browser Control cloud service. A visible page indicator identifies controlled
tabs, and the toolbar button attaches or detaches the active tab. Human handoff
controls keep authentication, payment confirmation, CAPTCHAs, and other
user-presence steps with the user rather than bypassing them.

Browser Control is intended for trusted local use. The extension requires the
local `@opencode-ai/browser-control` package.

## Permission Justifications

- `activeTab`: grants the user-initiated tab access required by
  `chrome.tabCapture.getMediaStreamId` when recording a toolbar-clicked tab.
- `alarms`: wakes the Manifest V3 worker periodically so it can reconnect to a
  local driver that starts after the browser.
- `debugger`: provides the Chrome DevTools Protocol transport required for
  Playwright to inspect and control user-authorized tabs.
- `offscreen`: hosts `MediaRecorder` while recording an authorized tab because
  a Manifest V3 service worker has no DOM media environment.
- `tabCapture`: records a controlled user tab only after an explicit local
  recording request.
- `tabGroups`: groups session-owned tabs under the visible `control` group and
  restores their prior ungrouped state when released.
- Content script on `<all_urls>`: installs the small status and human-handoff control in controlled
  pages across navigations and origins. It does not collect page content by
  itself; page access occurs through explicit local driver commands.

## Remote Code Declaration

The extension does not download or execute remotely hosted code in the
extension runtime. All extension JavaScript is bundled in the submitted
Manifest V3 package. As its disclosed purpose, the extension relays local
Chrome DevTools Protocol commands, including page-context evaluation, to tabs
controlled by the user.

## Data Use Disclosure

Declare access to website content; controlled-page and captured request URLs;
matching request and response headers and optional bodies; user activity on
controlled pages; authentication information available to controlled pages;
and screen or tab recordings requested by an authorized local caller. The data
is used only to provide the extension's single purpose. It is
not sold, used for advertising, used for credit decisions, or transferred to
the publisher. See `docs/PRIVACY.md`.

## Reviewer Instructions

1. Install Node.js 20 or later.
2. Run `npm install --global @opencode-ai/browser-control`.
3. Install the submitted Browser Control extension.
4. Run:

   ```bash
   browser-control execute 'await page.goto("https://example.com"); return { title: await page.title(), url: page.url() }'
   ```

5. Confirm that a controlled tab opens and the command returns `Example
   Domain`.
6. Open another ordinary web page and click the extension toolbar button once
   to attach it. Click again to detach it.
7. Run `browser-control doctor` to see local driver, extension protocol,
   session, and target diagnostics.

No account credentials are required for review. Recording is optional and
requires a separate explicit CLI request.

## Submission Artifact

Store assets live under `docs/chrome-web-store/`:

- `icon-128.png`
- `small-promo-440x280.png`

A 1280x800 or 640x400 product screenshot is still required before submission;
capture it from the final Store-ID-pinned build rather than staging a mock.

Run:

```bash
pnpm package:extension
```

Upload `artifacts/browser-control-extension-<version>.zip`. Record the printed
SHA-256 digest with the release notes.

The production relay accepts Store extension ID
`gmjpoplfomnnjipeiojccjbpjlodkjhn`. Source-mode relays additionally accept
unpacked development extension origins.
