import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { LeadSummary } from "@lette/shared";
import { listLeads } from "../api";
import { Avatar, Card, Shell } from "../components/ui";

// The roster the AI grounds against: names, contact, and the notes that drive
// personalised drafts.

export default function LeadsPage() {
  const [leads, setLeads] = useState<LeadSummary[] | null>(null);

  useEffect(() => {
    listLeads().then((res) => setLeads(res.leads));
  }, []);

  return (
    <Shell nav>
      <div className="px-5 py-12 sm:px-8">
        <header className="mb-8">
          <h1 className="text-[36px] font-bold leading-[1.15] tracking-tight">Leads</h1>
          <p className="mt-2 text-[16px] text-stone-500">
            The people you can invite — their notes personalise every drafted message.
          </p>
        </header>

        {!leads ? (
          <div className="space-y-3">
            <div className="shimmer h-16 rounded-2xl" />
            <div className="shimmer h-16 rounded-2xl" />
          </div>
        ) : leads.length === 0 ? (
          <Card className="text-center">
            <p className="text-xs font-bold uppercase tracking-wider text-emerald-800">AI drafts need context</p>
            <h2 className="mt-2 text-xl font-bold tracking-tight">No leads available</h2>
            <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-stone-500">
              Add leads to your roster before creating invitations. Their notes help Vera personalise every message.
            </p>
            <Link
              to="/admin"
              className="mt-5 inline-flex rounded-[14px] border border-stone-200 bg-white px-5 py-2.5 text-sm font-semibold text-emerald-800 shadow-card transition hover:border-emerald-700/40"
            >
              Return to the assistant
            </Link>
          </Card>
        ) : (
          <Card className="divide-y divide-stone-100 p-0">
            {leads.map((lead) => (
              <div key={lead.id} className="flex items-start gap-4 px-5 py-4 sm:items-center sm:px-6">
                <Avatar name={lead.name} />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold sm:flex sm:items-baseline sm:gap-2">
                    {lead.name}
                    <span className="block truncate font-normal text-stone-400 sm:inline">{lead.email}</span>
                  </p>
                  {lead.notes && <p className="mt-0.5 truncate text-sm text-stone-500">{lead.notes}</p>}
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>
    </Shell>
  );
}
