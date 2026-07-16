import { useEffect, useState } from "react";

// Vera's greeting types itself out on first visit — the chat idiom this surface borrows.
// Once per session only (a replay on every nav-back would wear thin), instant for
// prefers-reduced-motion, and instant in environments without matchMedia (jsdom/tests).
let greetingPlayed = false;

export function useTypedGreeting(fullText: string, ready: boolean): string {
  const [instant] = useState(
    () =>
      greetingPlayed ||
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
          greetingPlayed = true;
          return c;
        }
        return c + 2;
      });
    }, 16);
    return () => clearInterval(id);
  }, [ready, instant, fullText]);
  if (!ready) return "";
  return fullText.slice(0, Math.min(chars, fullText.length));
}

/** Let the greeting play again (used by the session reset test seam). */
export function resetGreeting() {
  greetingPlayed = false;
}
