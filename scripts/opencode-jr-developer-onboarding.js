await fillInputs(page, [
  {
    selector: page.getByRole("textbox", { name: "Account Name" }),
    value: "OpenCode Jr",
  },
  {
    selector: page.getByRole("textbox", { name: /Describe all of your use cases/i }),
    value: "OpenCode Jr is an automated responder for the OpenCode project. It monitors public posts that structurally mention the main @opencode account, admits requests only when the author is a stable allowlisted Anomaly team member, reads the relevant public conversation history for context, and posts one concise public reply from @OpenCodeJr. We use the official X API only. We do not access Direct Messages, sell or redistribute X data, follow users, like posts, delete posts, or perform unsolicited autonomous posting. Stored provider evidence is limited to the durable identifiers and public text required for request processing, thread continuity, reconnect backfill, and duplicate-reply prevention.",
  },
])
await page.bringToFront()
await handoff(
  "Review X's Developer Agreement and policies. If you accept them, check the three agreement boxes and click Submit. Complete any CAPTCHA or verification yourself. When the Developer Console dashboard is visible, use the in-page I'm done, continue control.",
  { timeoutMs: 1_800_000 },
)
if (!page.url().startsWith("https://console.x.com/")) {
  throw new Error(`Developer onboarding left the X console: ${page.url()}`)
}
return { url: page.url(), title: await page.title() }
