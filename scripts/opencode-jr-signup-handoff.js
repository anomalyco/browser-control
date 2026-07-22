await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60_000 })
await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').waitFor({ timeout: 30_000 })
await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').click()
await page.getByText(/Add an existing account/i).first().click()
await page.waitForURL(/x\.com\/i\/(flow\/login|jf\/onboarding)/, { timeout: 30_000 })
await page.evaluate(() => {
  const markInputs = () => {
    for (const input of document.querySelectorAll("input")) {
      input.setAttribute("data-1p-ignore", "true")
      input.setAttribute("data-lpignore", "true")
    }
  }
  markInputs()
  new MutationObserver(markInputs).observe(document.documentElement, { childList: true, subtree: true })
})
await page.bringToFront()
await handoff(
  "Create a new X account through account switching. Use display name OpenCode Jr and desired handle @OpenCodeJr. Enter private email/phone, birthday, CAPTCHA, verification code, password, and 2FA yourself. Do not submit the final Create account or Sign up action. Stop on the final review screen, then use the in-page I'm done, continue control.",
  { timeoutMs: 1_800_000 },
)
return {
  url: page.url(),
  finalCreateVisible: await page.getByRole("button", { name: /^(Sign up|Create account)$/i }).count() > 0,
}
