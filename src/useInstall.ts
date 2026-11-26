import { useEffect, useState } from "react";
import { useLocale } from "./i18n";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function isInstalledPwa() {
  const safariNavigator = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || safariNavigator.standalone === true;
}

function isIosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** PWA installation: the browser's install prompt where available, otherwise a guide for iOS. */
export function useInstall(onError: (message: string) => void) {
  const { t } = useLocale();
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isInstalledPwa);
  const [guideOpen, setGuideOpen] = useState(false);
  const iosDevice = isIosDevice();

  useEffect(() => {
    const displayMode = window.matchMedia("(display-mode: standalone)");
    const updateInstalled = () => setInstalled(isInstalledPwa());
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const installedApp = () => {
      setInstalled(true);
      setInstallPrompt(null);
      setGuideOpen(false);
    };
    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", installedApp);
    displayMode.addEventListener("change", updateInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", installedApp);
      displayMode.removeEventListener("change", updateInstalled);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) {
      setGuideOpen(true);
      return;
    }
    const prompt = installPrompt;
    setInstallPrompt(null);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") setInstalled(true);
    } catch {
      onError(t("Could not start installation."));
    }
  };

  return { canInstall: !installed && (!!installPrompt || iosDevice), guideOpen, closeGuide: () => setGuideOpen(false), install };
}
