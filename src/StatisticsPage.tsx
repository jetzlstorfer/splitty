import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Receipt } from "lucide-react";
import type { Entry } from "../shared/model";
import type { Preferences } from "./db";
import { categoryLabels, expenseCategory } from "./categories";
import ExpenseIcon from "./ExpenseIcon";
import { useLocale } from "./i18n";
import { summarizeStatistics } from "./statistics";

function moveMonth(month: string, offset: number) {
  const date = new Date(`${month}-01T12:00:00`);
  date.setMonth(date.getMonth() + offset);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export default function StatisticsPage({ entries, preferences }: { entries: Entry[]; preferences: Preferences }) {
  const { t, locale, money, amount, number, person } = useLocale();
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [month, setMonth] = useState(currentMonth);
  const [allTime, setAllTime] = useState(false);
  const anchorMonth = allTime ? currentMonth : month;
  const stats = useMemo(() => summarizeStatistics(entries, allTime ? null : month, anchorMonth), [entries, allTime, month, anchorMonth]);
  const monthLabel = (value: string, short = false) => new Date(`${value}-01T12:00:00`).toLocaleDateString(locale, {
    month: short ? "short" : "long", ...(short ? {} : { year: "numeric" })
  });
  const maxMonth = Math.max(1, ...stats.months.map((item) => Math.abs(item.total)));
  const maxCategory = Math.max(1, ...stats.categories.map((item) => Math.abs(item.total)));
  const maxPaid = Math.max(1, ...Object.values(stats.paid).map(Math.abs));
  const hasRefunds = stats.categories.some((item) => item.total < 0) || stats.months.some((item) => item.total < 0)
    || Object.values(stats.paid).some((total) => total < 0);
  const largest = stats.largest && stats.largest.amountCents > 0 ? stats.largest : null;

  return <section className="statistics-page">
    <header className="page-heading">
      <div><h1>{t("Statistics")}</h1><p>{t("Your shared life, in numbers.")}</p></div>
    </header>
    <div className="statistics-toolbar">
      <div className="statistics-period" role="group" aria-label={t("Statistics period")}>
        <button aria-pressed={!allTime} onClick={() => setAllTime(false)}>{t("Monthly")}</button>
        <button aria-pressed={allTime} onClick={() => setAllTime(true)}>{t("All time")}</button>
      </div>
      <div className="statistics-month">
        {!allTime && <button className="icon-button" aria-label={t("Previous month")} disabled={month <= "0001-01"} onClick={() => setMonth(moveMonth(month, -1))}><ChevronLeft size={20} /></button>}
        <span aria-live="polite">{allTime ? t("Your whole story") : monthLabel(month)}</span>
        {!allTime && <button className="icon-button" aria-label={t("Next month")} disabled={month >= "9999-12"} onClick={() => setMonth(moveMonth(month, 1))}><ChevronRight size={20} /></button>}
      </div>
    </div>

    <section className="statistics-hero" aria-label={t("Spending overview")}>
      <p>{t("Spent together")}</p>
      <strong className="statistics-total">{money(stats.total)}</strong>
      {!!stats.count && <small>{stats.count === 1 ? t("1 expense") : t("{count} expenses · Ø {amount} per expense", { count: number(stats.count), amount: money(stats.average) })}</small>}
    </section>

    {!stats.count && <div className="statistics-empty">
      <Receipt size={28} aria-hidden="true" /><h2>{t("A fresh page in your story")}</h2>
      <p>{t("No expenses in this period. Try another month or add an expense.")}</p>
    </div>}

    <section className="statistics-card" aria-label={t("Monthly spending")}>
      <h2 className="section-label">{t("Monthly spending")}</h2>
      <div className="statistics-chart">
        {stats.months.map((item) => {
          const selected = item.month === month && !allTime;
          return <button key={item.month} className={`statistics-bar-column ${selected ? "selected" : ""} ${item.total === 0 ? "empty" : ""}`}
            aria-label={`${monthLabel(item.month)}: ${money(item.total)}`}
            aria-pressed={selected}
            onClick={() => { setMonth(item.month); setAllTime(false); }}>
            <span className="statistics-bar-value" aria-hidden="true">{selected ? amount(item.total) : ""}</span>
            <span className="statistics-bar-track" aria-hidden="true">
              <span className={`statistics-bar ${item.total < 0 ? "refund" : ""}`} style={{ height: `${Math.abs(item.total) / maxMonth * 100}%` }} />
            </span>
            <span className="statistics-bar-label" aria-hidden="true">{monthLabel(item.month, true)}</span>
          </button>;
        })}
      </div>
      {hasRefunds && <p className="statistics-caption">{t("Striped bars show net refunds. Bar length shows the absolute amount.")}</p>}
    </section>

    {!!stats.count && <>
      <section className="statistics-card" aria-label={t("By category")}>
        <h2 className="section-label">{t("By category")}</h2>
        <ul className="statistics-list statistics-categories">
          {stats.categories.map(({ category, total }) => <li key={category}>
            <span className="statistics-category-icon" data-category={category}><ExpenseIcon category={category} size={19} /></span>
            <div className="statistics-list-detail">
              <span className="statistics-row-label">{t(categoryLabels[category])}</span>
              <div className="statistics-meter" aria-hidden="true"><span className={total < 0 ? "refund" : ""} style={{ width: `${Math.abs(total) / maxCategory * 100}%` }} /></div>
            </div>
            <strong>{amount(total)}</strong>
          </li>)}
        </ul>
      </section>

      <section className="statistics-card" aria-label={t("Who paid")}>
        <h2 className="section-label">{t("Who paid")}</h2>
        <ul className="statistics-list statistics-payers">
          {(["a", "b", "unknown"] as const).filter((key) => key !== "unknown" || stats.paid.unknown !== 0).map((key) => {
            const name = key === "unknown" ? t("Unknown · imported") : person(preferences, key);
            return <li className={`statistics-payer payer-${key}`} key={key}>
              <span className="avatar" aria-hidden="true">{key === "unknown" ? "?" : name.trim().charAt(0).toUpperCase() || "?"}</span>
              <div className="statistics-list-detail">
                <span className="statistics-row-label">{name}</span>
                <div className="statistics-meter" aria-hidden="true"><span className={stats.paid[key] < 0 ? "refund" : ""} style={{ width: `${Math.abs(stats.paid[key]) / maxPaid * 100}%` }} /></div>
              </div>
              <strong>{amount(stats.paid[key])}</strong>
            </li>;
          })}
        </ul>
        <p className="statistics-caption">{t("Payments between you are excluded. Imported payers are never guessed.")}</p>
      </section>

      {largest && <section className="statistics-card statistics-highlight" aria-label={t("Largest expense")}>
        <h2 className="section-label">{t("Largest expense")}</h2>
        <div className="statistics-highlight-row">
          {(() => {
            const category = expenseCategory(largest.description, largest.category, largest.kind, largest.categoryMode);
            return <span className="entry-icon" data-category={category}><ExpenseIcon category={category} /></span>;
          })()}
          <span className="entry-description"><strong>{largest.description}</strong>
            <small>{new Date(`${largest.date}T12:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })}{largest.paidBy && ` · ${t("{name} paid", { name: person(preferences, largest.paidBy) })}`}</small></span>
          <strong className="statistics-highlight-amount">{amount(largest.amountCents)}</strong>
        </div>
      </section>}
    </>}
    <p className="statistics-footnote">{t("Based on this device's saved entries. Includes imported expenses and refunds; excludes payments and deleted entries.")}</p>
  </section>;
}
