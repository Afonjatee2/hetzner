import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { WorkspaceError } from "@gpt-dev/schemas";

export const BrowserAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().url() }),
  z.object({ type: z.literal("click"), selector: z.string().min(1).max(512) }),
  z.object({ type: z.literal("fill"), selector: z.string().min(1).max(512), value: z.string().max(4096) }),
  z.object({ type: z.literal("press"), selector: z.string().min(1).max(512), key: z.string().min(1).max(64) }),
  z.object({ type: z.literal("wait"), milliseconds: z.number().int().min(0).max(30_000) }),
  z.object({ type: z.literal("screenshot"), name: z.string().regex(/^[a-zA-Z0-9._-]+\.png$/) })
]);

export type BrowserAction = z.infer<typeof BrowserAction>;

function assertAllowedUrl(value: string, allowedHosts: Set<string>): void {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new WorkspaceError("FORBIDDEN", "Only HTTP(S) browser navigation is allowed");
  if (!allowedHosts.has(url.hostname)) throw new WorkspaceError("FORBIDDEN", `Browser host is not approved: ${url.hostname}`);
  if (url.username || url.password) throw new WorkspaceError("FORBIDDEN", "Credentials in browser URLs are forbidden");
}

export class BrowserService {
  async createScript(artifactDirectory: string, actions: BrowserAction[], allowedHosts: string[]): Promise<string> {
    if (actions.length > 100) throw new WorkspaceError("VALIDATION", "Too many browser actions");
    const hosts = new Set(allowedHosts);
    for (const action of actions) if (action.type === "navigate") assertAllowedUrl(action.url, hosts);
    const serialized = JSON.stringify(actions);
    const script = `
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const actions = ${serialized};
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const events = { console: [], pageErrors: [], failedRequests: [], responses: [] };
page.on('console', m => events.console.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => events.pageErrors.push(String(e)));
page.on('requestfailed', r => events.failedRequests.push({ url: r.url(), error: r.failure()?.errorText }));
page.on('response', r => { if (r.status() >= 400) events.responses.push({ url: r.url(), status: r.status() }); });
await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
for (const action of actions) {
  if (action.type === 'navigate') await page.goto(action.url, { waitUntil: 'networkidle', timeout: 30000 });
  else if (action.type === 'click') await page.locator(action.selector).click();
  else if (action.type === 'fill') await page.locator(action.selector).fill(action.value);
  else if (action.type === 'press') await page.locator(action.selector).press(action.key);
  else if (action.type === 'wait') await page.waitForTimeout(action.milliseconds);
  else if (action.type === 'screenshot') await page.screenshot({ path: '/artifacts/' + action.name, fullPage: true });
}
await page.context().tracing.stop({ path: '/artifacts/trace.zip' });
await writeFile('/artifacts/browser-events.json', JSON.stringify(events, null, 2));
await browser.close();
`;
    const path = resolve(artifactDirectory, "browser-check.mjs");
    await writeFile(path, script, { encoding: "utf8", mode: 0o640 });
    return path;
  }
}
