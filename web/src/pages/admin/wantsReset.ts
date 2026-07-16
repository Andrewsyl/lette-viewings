// Clear ways an admin asks to scrap the current draft and begin again. The preview isn't
// created yet, so "start over" / "remove that" / "I don't want it" mean reset the exchange
// — not a scheduling instruction for the parser to puzzle over (and re-propose). Kept
// conservative: "remove the 2pm one" or "drop Priya" are refinements, not resets.
// Note: "cancel" is deliberately NOT a reset verb — "cancel all viewings" is a real
// bulk-cancel of booked viewings, not a draft reset. Reset words are draft-scoped.
const RESET_INTENT = new RegExp(
  [
    "start over",
    "start again",
    "starting over",
    "never ?mind",
    "forget (it|about it|this|that)",
    "\\b(scrap|discard|reset)\\b",
    "get rid of (it|that|this|the (listing|draft|preview|proposal))",
    "(remove|delete|clear|scrap|discard)( the)? (listing|draft|preview|proposal)",
    "(remove|delete|take|clear|get rid of)\\b[^.]*\\bchat\\b", // "remove it from the chat"
    "(remove|delete|scrap|discard)( the| that| this| it)?\\s*$", // "remove that", "delete it"
    "don'?t want (it|this|that|the (listing|draft|proposal|viewings?))",
  ].join("|"),
  "i"
);
export function wantsReset(text: string): boolean {
  return RESET_INTENT.test(text.trim());
}
