import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SyncIcon from "./SyncIcon";

const states = ["current", "syncing", "pending", "attention", "offline"] as const;
const render = (state: typeof states[number]) => renderToStaticMarkup(createElement(SyncIcon, { state }));

describe("sync status icons", () => {
  it.each(states)("draws %s in one accessible, fixed-size SVG", (state) => {
    const markup = render(state);
    expect(markup.match(/<svg\b/g)).toHaveLength(1);
    expect(markup).toContain(`data-sync-state="${state}"`);
    expect(markup).toContain('width="24" height="24" viewBox="0 0 24 24"');
    expect(markup).toContain('aria-hidden="true" focusable="false"');
    expect(markup).toContain('class="sync-cloud"');
    expect(markup.includes('class="sync-arrows"')).toBe(state === "syncing");
    expect(markup.includes('class="sync-check"')).toBe(state === "current");
    expect(markup.includes("<circle")).toBe(state === "pending");
  });

  it("keeps the same cloud outline across every state", () => {
    const outlines = states.map((state) => render(state).match(/class="sync-cloud" d="([^"]+)"/)?.[1]);
    expect(outlines[0]).toBeTruthy();
    expect(new Set(outlines).size).toBe(1);
  });

  it("keeps the pending clock large enough to read at the native icon size", () => {
    const markup = render("pending");
    expect(markup).toContain('<circle cx="12" cy="13.5" r="4.25"');
    expect(markup).toContain('d="M12 11v2.5l1.75 1"');
  });
});
