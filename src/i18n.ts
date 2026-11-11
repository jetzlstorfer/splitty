import { createContext, useContext } from "react";
import { localizeMessage, localeFor, translate, type Language, type MessageKey, type Parameters } from "../shared/i18n";
import type { Member } from "../shared/model";
import type { Preferences } from "./db";

export const LanguageContext = createContext<Language>("de");

export function useLocale() {
  const language = useContext(LanguageContext);
  const locale = localeFor(language);
  const t = (key: MessageKey, values?: Parameters) => translate(language, key, values);
  const money = (cents: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(cents / 100);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const amount = (cents: number) => new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
  const message = (value: string) => localizeMessage(value, language);
  const person = (preferences: Preferences, member: Member) => {
    const name = member === "a" ? preferences.nameA : preferences.nameB;
    // Keep the stored legacy placeholder compatible without rewriting household names.
    return !name || name === (member === "a" ? "You" : "Your wife") || (member === "b" && name === "Your spouse")
      ? t(member === "a" ? "You" : "Your spouse") : name;
  };
  const payer = (preferences: Preferences, member: Member) => {
    const name = person(preferences, member);
    return name === t(member === "a" ? "You" : "Your spouse") ? t(member === "a" ? "First person" : "Second person") : name;
  };
  return { language, locale, t, money, amount, number, message, person, payer };
}
