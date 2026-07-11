import { getSupabaseClient } from "@/lib/supabase";
import { getDashboardData } from "@/lib/status";

export const dynamic = "force-dynamic";

export default async function StatusPage() {
  const { status, events } = await getDashboardData(getSupabaseClient());

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
      <h1>ZAOpaperzBOT Status</h1>
      <p>
        <strong>{status.online ? "Online" : "Offline / unknown"}</strong>
        {status.lastSeen ? ` - last seen ${new Date(status.lastSeen).toLocaleString()}` : ""}
      </p>
      <p>Servers installed: {status.guildCount ?? "unknown"}</p>
      <p>
        FAQ cache age:{" "}
        {status.faqCacheAgeMinutes != null ? `${Math.round(status.faqCacheAgeMinutes)} min` : "unknown"}
      </p>

      <h2>Recent activity</h2>
      {events.length === 0 ? (
        <p>No recent activity recorded yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Question</th>
              <th>Matched</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.ts).toLocaleString()}</td>
                <td>{e.message}</td>
                <td>{e.meta && typeof e.meta.matched === "boolean" ? (e.meta.matched ? "yes" : "no") : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
