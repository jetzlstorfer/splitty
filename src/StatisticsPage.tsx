import { useMemo, useState } from "react";
import { ArrowUpRight, BarChart3, ChevronLeft, ChevronRight, Receipt, Sparkles } from "lucide-react";
import type { Entry } from "../shared/model";
import type { Preferences } from "./db";
import { categoryLabels } from "./categories";
import ExpenseIcon from "./ExpenseIcon";
import { useLocale } from "./i18n";
import { summarizeStatistics } from "./statistics";

function moveMonth(month: string, offset: number) {
  const date = new Date(`${month}-01T12:00:00`);
  date.setMonth(date.getMonth() + offset);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export default function StatisticsPage({ entries, preferences }: { entries: Entry[]; preferences: Preferences }) {
  const { t, locale, money, number, person } = useLocale();
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

  return <section className="statistics-page">
    <header className="page-heading statistics-heading">
      <div><h1>{t("Statistics")}</h1><p>{t("Your shared life, in numbers.")}</p></div>
      <span className="statistics-badge" aria-hidden="true"><BarChart3 size={24} /></span>
    </header>
    <div className="statistics-period" role="group" aria-label={t("Statistics period")}>
      <button aria-pressed={!allTime} onClick={() => setAllTime(false)}>{t("Monthly")}</button>
      <button aria-pressed={allTime} onClick={() => setAllTime(true)}>{t("All time")}</button>
    </div>
    <div className="statistics-month">
      {!allTime && <button className="icon-button" aria-label={t("Previous month")} disabled={month <= "0001-01"} onClick={() => setMonth(moveMonth(month, -1))}><ChevronLeft size={20} /></button>}
      <span aria-live="polite">{allTime ? t("Your whole story") : monthLabel(month)}</span>
      {!allTime && <button className="icon-button" aria-label={t("Next month")} disabled={month >= "9999-12"} onClick={() => setMonth(moveMonth(month, 1))}><ChevronRight size={20} /></button>}
    </div>

    <section className="statistics-hero accent-hero" aria-label={t("Spending overview")}>
      <div className="statistics-eyebrow"><Sparkles size={16} aria-hidden="true" />{t("Total spending")}</div>
      <strong className="statistics-total">{money(stats.total)}</strong>
      <p>{t("Together, not what you owe.")}</p>
      <dl className="statistics-metrics">
        <div><dt>{t("Expenses")}</dt><dd>{number(stats.count)}</dd></div>
        <div><dt>{t("Average expense")}</dt><dd>{money(stats.average)}</dd></div>
      </dl>
    </section>

    {!stats.count && <div className="statistics-empty">
      <Receipt size={28} aria-hidden="true" /><h2>{t("A fresh page in your story")}</h2>
      <p>{t("No expenses in this period. Try another month or add an expense.")}</p>
    </div>}

    <section className="statistics-card" aria-label={t("Monthly spending")}>
      <div className="statistics-card-heading"><h2>{t("Monthly spending")}</h2><span>{t("6 months")}</span></div>
      <p className="statistics-caption">{t("Tap a month to explore")}</p>
      <div className="statistics-chart">
        {stats.months.map((item) => <button key={item.month} className={`statistics-bar-column ${item.month === month && !allTime ? "selected" : ""}`}
          aria-label={`${monthLabel(item.month)}: ${money(item.total)}`}
          aria-pressed={item.month === month && !allTime}
          onClick={() => { setMonth(item.month); setAllTime(false); }}>
          <span className="statistics-bar-track" aria-hidden="true">
            <span className={`statistics-bar ${item.total < 0 ? "refund" : ""}`} style={{ height: `${Math.abs(item.total) / maxMonth * 100}%` }} />
          </span>
          <span className="statistics-bar-label">{monthLabel(item.month, true)}</span>
          <span className="statistics-bar-value">{money(item.total)}</span>
        </button>)}
      </div>
      {hasRefunds && <p className="statistics-caption">{t("Striped bars show net refunds. Bar length shows the absolute amount.")}</p>}
    </section>

    {!!stats.count && <>
      <section className="statistics-card" aria-label={t("By category")}>
        <div className="statistics-card-heading"><h2>{t("By category")}</h2><span>{t("Where it went")}</span></div>
        <ul className="statistics-categories">
          {stats.categories.map(({ category, total }) => <li key={category}>
            <span className="statistics-category-icon" data-category={category}><ExpenseIcon category={category} size={20} /></span>
            <div className="statistics-category-detail">
              <div className="statistics-row-label"><span>{t(categoryLabels[category])}</span><strong>{money(total)}</strong></div>
              <div className="statistics-meter" aria-hidden="true"><span className={total < 0 ? "refund" : ""} style={{ width: `${Math.abs(total) / maxCategory * 100}%` }} /></div>
            </div>
          </li>)}
        </ul>
      </section>

      <section className="statistics-card" aria-label={t("Who paid")}>
        <div className="statistics-card-heading"><h2>{t("Who paid")}</h2><span>{t("Out of pocket")}</span></div>
        {(["a", "b", "unknown"] as const).filter((key) => key !== "unknown" || stats.paid.unknown !== 0).map((key) => <div className={`statistics-payer payer-${key}`} key={key}>
          <div className="statistics-row-label"><span>{key === "unknown" ? t("Unknown · imported") : person(preferences, key)}</span><strong>{money(stats.paid[key])}</strong></div>
          <div className="statistics-meter" aria-hidden="true"><span className={stats.paid[key] < 0 ? "refund" : ""} style={{ width: `${Math.abs(stats.paid[key]) / maxPaid * 100}%` }} /></div>
        </div>)}
        <p className="statistics-caption">{t("Payments between you are excluded. Imported payers are never guessed.")}</p>
      </section>

      {stats.largest && stats.largest.amountCents > 0 && <section className="statistics-highlight" aria-label={t("Largest expense")}>
        <span className="statistics-category-icon"><ArrowUpRight size={23} aria-hidden="true" /></span>
        <div><h2>{t("Largest expense")}</h2><p>{stats.largest.description}</p><small>{new Date(`${stats.largest.date}T12:00:00`).toLocaleDateString(locale)}</small></div>
        <strong>{money(stats.largest.amountCents)}</strong>
      </section>}
    </>}
    <p className="statistics-footnote">{t("Based on this device's saved entries. Includes imported expenses and refunds; excludes payments and deleted entries.")}</p>
  </section>;
}
