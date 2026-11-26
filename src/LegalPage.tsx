import { useEffect } from "react";
import type { MessageKey } from "../shared/i18n";
import { useLocale } from "./i18n";

type LegalDocument = "privacy" | "terms";
interface Section { heading: MessageKey; paragraphs: MessageKey[] }

const titles: Record<LegalDocument, MessageKey> = {
  privacy: "Privacy policy",
  terms: "Terms of service"
};

const sections: Record<LegalDocument, Section[]> = {
  privacy: [
    { heading: "Operator and contact", paragraphs: ["Jürgen Etzlstorfer, Hagenberg im Mühlkreis"] },
    {
      heading: "Data and use",
      paragraphs: [
        "Splitty is a free, non-commercial project. It uses household names, expense details, amounts, shares, settlements and to-dos to provide a shared ledger. Synced household data is stored in a Microsoft Azure cloud region within the EU and shared with authorized household members.",
        "When enabled, sign-in is handled by Microsoft Entra using email, Google or Microsoft accounts. Splitty receives an account identifier and profile details such as your name and email, not your password. See the providers' privacy notices below.",
        "Optional receipt scanning reads photos on your device. Splitty does not upload or store receipt photos or recognized text; only expense details you save are synced."
      ]
    },
    {
      heading: "Storage and deletion",
      paragraphs: [
        "Your browser stores local entries for offline use; clearing it may remove unsynced data. Deleting a synced entry does not erase copies on other devices or in backups.",
        "You can request a copy or backup of your data, or request deletion, from the operator."
      ]
    }
  ],
  terms: [
    { heading: "Operator and scope", paragraphs: ["Jürgen Etzlstorfer, Hagenberg im Mühlkreis"] },
    {
      heading: "What the service does",
      paragraphs: [
        "Splitty is a free, non-commercial project: it provides a shared household expense ledger and to-do list, but does not transfer money or give financial, tax or legal advice."
      ]
    },
    {
      heading: "Using Splitty",
      paragraphs: [
        "Only enter information you may share. Authorized household members can read and change synced records. Check entries and keep your own backups; browser data can be lost, and service availability or sync is not guaranteed."
      ]
    }
  ]
};

export function LegalLinks({ active }: { active?: LegalDocument }) {
  const { t, language } = useLocale();
  return <footer className="legal-links" aria-label={t("Legal information")}>
    {(["privacy", "terms"] as const).map((page) =>
      <a key={page} href={`/${page}?lang=${language}`} aria-current={active === page ? "page" : undefined}>{t(titles[page])}</a>)}
  </footer>;
}

export default function LegalPage({ page }: { page: LegalDocument }) {
  const { t, language } = useLocale();
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return <div className="app-shell legal-page">
    <title>{`${t(titles[page])} | Splitty`}</title>
    <header className="topbar">
      <a className="wordmark" href="/" aria-label={t("Splitty home")}><img className="brand-mark" src="/icon.svg" width="32" height="32" alt="" />Splitty</a>
      <div className="legal-language" role="group" aria-label={t("Language")}>
        <a href={`/${page}?lang=de`} lang="de" hrefLang="de" aria-current={language === "de" ? "true" : undefined}>Deutsch</a>
        <a href={`/${page}?lang=en`} lang="en" hrefLang="en" aria-current={language === "en" ? "true" : undefined}>English</a>
      </div>
    </header>
    <main className="legal-document">
      <header className="page-heading"><div><h1>{t(titles[page])}</h1></div></header>
      {sections[page].map((section) => <section key={section.heading}>
        <h2>{t(section.heading)}</h2>
        {section.paragraphs.map((paragraph) => <p key={paragraph}>{t(paragraph)}</p>)}
      </section>)}
      {page === "privacy" && <section>
        <h2>{t("Provider privacy notices")}</h2>
        <ul>
          <li><a href="https://privacy.microsoft.com/privacystatement">{t("Microsoft privacy statement")}</a></li>
          <li><a href="https://policies.google.com/privacy">{t("Google privacy policy")}</a></li>
        </ul>
      </section>}
      <LegalLinks active={page} />
    </main>
  </div>;
}
