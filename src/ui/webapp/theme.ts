import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

const THEME_KEY = "workflow.theme";
const LIGHT_SCHEME = "(prefers-color-scheme: light)";

function readChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "dark" || stored === "light" ? stored : "system";
  } catch {
    // Private browsing or storage disabled: the choice stays session-local.
    return "system";
  }
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  if (choice !== "system") return choice;
  return window.matchMedia(LIGHT_SCHEME).matches ? "light" : "dark";
}

function apply(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "light" ? "#f3f4f6" : "#101216");
}

/**
 * Applies the stored choice before first paint (called from main.tsx) so a
 * light-theme operator never sees a dark flash. Presentation-only: theming
 * never reaches the server or the agent.
 */
export function applyStoredTheme(): void {
  apply(resolve(readChoice()));
}

/**
 * Color-theme control. Mounted once at the app root so "System" follows the
 * OS for the whole session, not only while the settings popover is open;
 * the popover reads/writes the same choice through props.
 */
export function useTheme(): {
  readonly choice: ThemeChoice;
  readonly setChoice: (choice: ThemeChoice) => void;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);

  useEffect(() => {
    apply(resolve(choice));
    if (choice !== "system") return;
    const media = window.matchMedia(LIGHT_SCHEME);
    const onChange = (): void => apply(resolve("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice): void => {
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage unavailable: the choice applies for this session only.
    }
    setChoiceState(next);
  }, []);

  return { choice, setChoice };
}
