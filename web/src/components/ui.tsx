import type { ButtonHTMLAttributes, ReactNode } from "react";
import { NavLink } from "react-router-dom";

// Small shared kit so the pages compose from consistent pieces instead of
// re-inventing class strings. Deliberately tiny — a design system is overkill
// for two pages; consistency isn't.

type ButtonVariant = "primary" | "accent" | "ghost";

// CTA behaviour carried from freespace.ie's .btn-primary: semibold, 14px radius,
// card shadow, and the hover lift (-translate-y-0.5 + deeper shadow) with a subtle
// press (active:scale). The lift is the house signature — buttons feel physical.
const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    "rounded-[14px] bg-stone-900 text-white shadow-card hover:-translate-y-0.5 hover:bg-stone-700 hover:shadow-lg active:scale-[0.99] disabled:hover:translate-y-0 disabled:hover:bg-stone-900 disabled:hover:shadow-card",
  accent:
    "rounded-[14px] bg-emerald-700 text-white shadow-card hover:-translate-y-0.5 hover:bg-emerald-800 hover:shadow-lg active:scale-[0.99] disabled:hover:translate-y-0 disabled:hover:bg-emerald-700 disabled:hover:shadow-card",
  ghost: "rounded-full text-stone-500 hover:text-stone-900",
};

export function Button({
  variant = "primary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center px-5 py-2.5 text-[15px] font-semibold transition disabled:opacity-40 ${buttonStyles[variant]} ${className}`}
      {...rest}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl bg-white p-7 shadow-card ${className}`}>
      {children}
    </div>
  );
}

// Status chips in the register of Lette's product: outlined white pills, quiet text —
// not filled colour blocks.
export function Badge({ children, tone = "stone" }: { children: ReactNode; tone?: "stone" | "green" | "amber" }) {
  const tones = {
    stone: "text-stone-600",
    green: "text-emerald-800",
    amber: "text-amber-800",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-xs font-semibold text-stone-600">
      {initials}
    </span>
  );
}

/** Big calendar-style date block: TUE / 21 Jul / 14:00 */
export function DateBlock({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-xl bg-stone-100/70 leading-none">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-800">
        {d.toLocaleDateString("en-IE", { weekday: "short" })}
      </span>
      <span className="mt-1 text-lg font-bold text-stone-900">{d.getDate()}</span>
      <span className="text-[10px] font-medium uppercase text-stone-500">
        {d.toLocaleDateString("en-IE", { month: "short" })}
      </span>
    </div>
  );
}

/** Capacity as filled/empty dots, with the accessible text alongside. */
export function CapacityDots({ taken, max }: { taken: number; max: number }) {
  const dots = Array.from({ length: Math.min(max, 12) }, (_, i) => i < taken);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex gap-1" aria-hidden="true">
        {dots.map((filled, i) => (
          <span
            key={i}
            className={`h-2 w-2 rounded-full ${filled ? "bg-emerald-700" : "border border-stone-300 bg-white"}`}
          />
        ))}
      </span>
      <span className="text-sm text-stone-500">
        {max - taken} of {max} spots remaining
      </span>
    </span>
  );
}

const NAV_ITEMS = [
  { to: "/admin", label: "New viewing", end: true },
  { to: "/admin/slots", label: "Slots", end: false },
  { to: "/admin/leads", label: "Leads", end: false },
];

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-700 text-xs font-extrabold text-white shadow-card">
        V
      </span>
      <span className="text-[15px] font-bold tracking-tight text-stone-900">Viewings</span>
      <span className="ml-1 rounded-full border border-stone-200 bg-white px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
        demo
      </span>
    </div>
  );
}

/** Two registers, deliberately:
 *  - Admin (`nav`): a full-bleed work surface — full-height sidebar, edge to edge, the
 *    way tools people live in are built (workspace is never spent on decoration).
 *  - Invitee (no nav): a framed floating card over the ambient scene — the register of
 *    something you *receive*, like a ticket. Tenants see an invitation, not our chrome. */
export function Shell({ children, nav = false }: { children: ReactNode; nav?: boolean }) {
  if (nav) {
    return (
      <div className="flex min-h-screen flex-col bg-stone-50 md:flex-row">
        <aside className="border-b border-stone-200/70 bg-white/60 px-4 py-4 backdrop-blur md:flex md:min-h-screen md:w-56 md:shrink-0 md:flex-col md:border-b-0 md:border-r md:px-4 md:py-5">
          <div className="mb-1 px-1 md:mb-8">
            <Wordmark />
          </div>
          <nav aria-label="Main" className="mt-3 flex gap-1 md:mt-0 md:flex-col">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-xl px-3.5 py-2 text-sm font-semibold transition ${
                    isActive
                      ? "bg-stone-100 text-stone-900"
                      : "text-stone-500 hover:text-stone-800"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    );
  }
  return (
    <div className="min-h-screen px-3 py-3 sm:px-8 sm:py-6">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-2xl flex-col overflow-hidden rounded-[28px] bg-stone-50 shadow-[0_32px_90px_rgba(15,23,42,0.28)] ring-1 ring-black/5">
        <header className="border-b border-stone-200/60 bg-white/70 px-6 py-3.5 backdrop-blur-md">
          <Wordmark />
        </header>
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}

/** Quiet three-step orientation: Describe → Review → Send. */
export function Steps({ current }: { current: 0 | 1 | 2 }) {
  const labels = ["Describe", "Review", "Send"];
  return (
    <nav aria-label="Progress" className="mb-8 flex items-center gap-2 text-xs font-semibold">
      {labels.map((label, i) => (
        <span key={label} className="flex items-center gap-2">
          {i > 0 && <span className="h-px w-6 bg-stone-300" aria-hidden="true" />}
          <span
            className={
              i === current
                ? "rounded-full bg-emerald-50 px-3 py-1 text-emerald-800"
                : i < current
                  ? "px-1 text-emerald-700"
                  : "px-1 text-stone-400"
            }
          >
            {i < current ? "✓ " : ""}
            {label}
          </span>
        </span>
      ))}
    </nav>
  );
}

/** Typing indicator shown beside a lead while their draft streams. */
export function TypingDots() {
  return (
    <span className="typing-dots inline-flex items-center" aria-label="writing">
      <span />
      <span />
      <span />
    </span>
  );
}

export function SkeletonPreview() {
  return (
    <div className="space-y-3" aria-label="Interpreting your request">
      <div className="shimmer h-4 w-40 rounded" />
      <div className="flex gap-3">
        <div className="shimmer h-16 w-16 rounded-xl" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="shimmer h-4 w-2/3 rounded" />
          <div className="shimmer h-3 w-1/2 rounded" />
        </div>
      </div>
      <div className="flex gap-3">
        <div className="shimmer h-16 w-16 rounded-xl" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="shimmer h-4 w-1/2 rounded" />
          <div className="shimmer h-3 w-1/3 rounded" />
        </div>
      </div>
    </div>
  );
}
