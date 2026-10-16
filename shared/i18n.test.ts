import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { german, isMessageKey, localizeMessage, localeFor, translate, type MessageKey } from "./i18n";

describe("German and English translations", () => {
  it("keeps all placeholders aligned across languages", () => {
    for (const key of Object.keys(german) as MessageKey[]) {
      expect(german[key].length).toBeGreaterThan(0);
      expect(german[key].match(/\{\w+\}/g)?.sort() ?? []).toEqual(key.match(/\{\w+\}/g)?.sort() ?? []);
    }
  });
  it("interpolates values without treating them as templates or markup", () => {
    expect(translate("de", "{name} owes you", { name: "<b>{name}</b>" })).toBe("<b>{name}</b> schuldet dir");
    expect(translate("en", "{name} owes you", { name: "Sam" })).toBe("Sam owes you");
  });
  it("localizes import row failures and transient messages at render time", () => {
    expect(localizeMessage("Row 3: Only EUR is supported; no automatic currency conversion.", "de")).toMatch(/^Zeile 3: Es wird nur EUR/);
    expect(localizeMessage("Saved on this device", "de")).toBe("Auf diesem Gerät gespeichert");
    expect(localizeMessage("Saved on this device", "en")).toBe("Saved on this device");
    expect(localizeMessage("Failed to fetch", "de")).toMatch(/^Die Netzwerkanfrage/);
    expect(localizeMessage("CSV could not be read: Too many fields", "de")).toMatch(/^Die CSV konnte nicht/);
    expect(localizeMessage("Unknown browser failure", "de")).toMatch(/^Ein unerwarteter Fehler/);
  });
  it("covers static errors exposed by the model, storage and API", () => {
    for (const file of ["shared\\model.ts", "src\\db.ts", "src\\sync.ts", "src\\importer.ts", "api\\src\\handler.ts", "api\\src\\config.ts", "api\\src\\auth.ts"]) {
      const source = readFileSync(file.replaceAll("\\", process.platform === "win32" ? "\\" : "/"), "utf8");
      const matches = source.matchAll(/throw new (?:Error|HttpError|ApiError)\((?:\d+, )?"([^"]+)"/g);
      for (const match of matches) {
        expect(isMessageKey(match[1]), `Missing translation in ${file}: ${match[1]}`).toBe(true);
      }
    }
  });
  it("formats amounts/dates with the chosen locale", () => {
    const parts = new Intl.NumberFormat(localeFor("de")).formatToParts(1234.56);
    expect(parts.find((part) => part.type === "decimal")?.value).toBe(",");
    expect(parts.filter((part) => part.type === "integer").map((part) => part.value).join("")).toBe("1234");
    expect(new Intl.NumberFormat(localeFor("en")).format(1234.56)).toBe("1,234.56");
    expect(new Intl.DateTimeFormat(localeFor("de"), { month: "long" }).format(new Date("2024-10-01"))).toBe("Oktober");
  });
});
