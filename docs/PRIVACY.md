# Browser Control Extension Privacy Policy

Effective July 20, 2026

Browser Control is a local browser driver for user-authorized automation. This
policy describes the Browser Control browser extension distributed by Anomaly
and the local Browser Control driver it connects to.

## Data The Extension Can Access

Trusted programs using the local driver can
control attached tabs and tabs they create. Depending on the command you run,
that access can include:

- Page URLs, titles, visible and programmatically available page content.
- Form fields and interactions performed on controlled pages.
- The signed-in state available to the controlled page.
- Browser debugging events and network activity associated with controlled
  pages, including matching cross-origin requests and responses.
- Images or recordings of a controlled tab when an authorized local caller
  requests them.

Browser Control does not collect this data for advertising, analytics, credit
decisions, or sale to third parties.

Browser Control's use of information received from Google APIs complies with
the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Local Processing

The extension connects to the Browser Control driver at
`127.0.0.1:19989` on the same computer. Browser data handled by the extension is
sent only over this loopback connection to the local driver. Anomaly does not
operate a Browser Control cloud relay and does not receive page contents,
browsing history, credentials, debugging events, screenshots, or recordings.

Programs and agents you authorize to call the local driver may receive data
returned by the commands they run. Their handling of that data is governed by
the software and services you chose to run, not by Browser Control.

## Local Storage

The extension does not store browsing data. The local driver stores relay state,
session descriptors, access-restricted secret profiles, and execution journals
under `~/.browser-control`. Journals can include agent code, bounded result
previews, page URLs, navigations, errors, and handoff summaries. Screenshots,
recordings, and network exports are written to the path selected by the caller.
Disabling or removing the extension does not automatically delete these local
files. You can delete sessions through the Browser Control CLI and remove
user-selected artifacts normally. Local sessions, journals, captures, and
secret profiles remain until the user deletes their corresponding files or
Browser Control data.

## Your Controls

The extension visibly marks controlled tabs. Its toolbar button attaches or
detaches the active tab, subject to safeguards for active operations. You can
reset or delete Browser Control sessions with the local CLI. You can stop all
extension activity by disabling or removing Browser Control from your
browser's extensions page.

## Security

Browser Control is intended for trusted local use. Only enable it on a computer
where you trust the programs and agents that can access the local driver. The
driver rejects cross-origin browser requests, limits its listener to local
interfaces by default, and blocks destructive browser-wide debugging commands,
but a trusted caller controlling a tab can still read and modify that tab.

## Changes And Contact

Material changes to Browser Control's data handling will be reflected in this
policy and the Chrome Web Store listing. Questions and reports can be filed at
<https://github.com/anomalyco/browser-control/issues>.
