import { TypingDots } from "../../components/ui";
import type { ThreadTurn } from "./session";

export function Thread(props: { turns: ThreadTurn[]; busy: boolean; label?: string }) {
  return (
    <div className="space-y-3" aria-label={props.label ?? "Conversation"}>
      {props.turns.map((turn, i) =>
        turn.role === "admin" ? (
          <div key={i} className="fade-up flex justify-end">
            <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-emerald-700 px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-card">
              {turn.text}
            </p>
          </div>
        ) : (
          <div key={i} className="fade-up flex items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-xs font-extrabold text-white shadow-card">
              V
            </span>
            <p className="max-w-[85%] rounded-2xl rounded-tl-md border border-stone-200/80 bg-white px-4 py-2.5 text-[15px] leading-relaxed text-stone-700 shadow-card">
              {turn.text}
            </p>
          </div>
        )
      )}
      {props.busy && (
        <div className="flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-xs font-extrabold text-white shadow-card">
            V
          </span>
          <div className="rounded-2xl rounded-tl-md border border-stone-200/80 bg-white px-4 py-3 shadow-card">
            <span className="sr-only">Understanding your request…</span>
            <TypingDots />
          </div>
        </div>
      )}
    </div>
  );
}
