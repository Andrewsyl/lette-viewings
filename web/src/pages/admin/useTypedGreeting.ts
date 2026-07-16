import { useEffect, useState } from "react";

/** Reveal known text a few characters per tick — the chat idiom for "Vera is speaking".
 *  Pacing of real content, never a fake wait: the full text lands in well under a second.
 *  Instant when `enabled` is false, when the user prefers reduced motion, or in
 *  environments without matchMedia (jsdom/tests). */
export function useTypewriter(
  fullText: string,
  ready: boolean,
  enabled: boolean,
  onDone?: () => void
): string {
  const [instant] = useState(
    () =>
      !enabled ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [chars, setChars] = useState(instant ? Number.MAX_SAFE_INTEGER : 0);
  useEffect(() => {
    if (!ready || instant) return;
    const id = setInterval(() => {
      setChars((c) => {
        if (c >= fullText.length) {
          clearInterval(id);
          onDone?.();
          return c;
        }
        return c + 2;
      });
    }, 16);
    return () => clearInterval(id);
    // onDone is intentionally not a dependency — restarting the animation because a
    // parent re-rendered with a fresh closure would stutter the typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, instant, fullText]);
  if (!ready) return "";
  return fullText.slice(0, Math.min(chars, fullText.length));
}

// Vera's greeting types itself out on first visit — once per session only (a replay on
// every nav-back would wear thin).
let greetingPlayed = false;

export function useTypedGreeting(fullText: string, ready: boolean): string {
  return useTypewriter(fullText, ready, !greetingPlayed, () => {
    greetingPlayed = true;
  });
}

/** Let the greeting play again (used by the session reset test seam). */
export function resetGreeting() {
  greetingPlayed = false;
}
