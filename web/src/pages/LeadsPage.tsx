import { useEffect, useState } from "react";
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
        ) : (
          <Card className="divide-y divide-stone-100 p-0">
            {leads.map((lead) => (
              <div key={lead.id} className="flex items-center gap-4 px-6 py-4">
                <Avatar name={lead.name} />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold">
                    {lead.name}
                    <span className="ml-2 font-normal text-stone-400">· {lead.email}</span>
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
