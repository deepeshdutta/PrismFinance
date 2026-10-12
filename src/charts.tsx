import { Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { money } from "./lib/money";

const SLICE = ["var(--color-pine)", "var(--color-ink)", "var(--color-clay)", "var(--color-muted)", "var(--color-line)"];

function monthLabel(asOf: string) {
  return new Date(`${asOf}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
}

export function TrendChart({ points }: { points: { asOf: string; netCents: number }[] }) {
  const data = points.map((point) => ({ label: monthLabel(point.asOf), net: point.netCents / 100 }));
  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--color-muted)", fontSize: 12 }} />
          <YAxis hide domain={["dataMin - 1000", "dataMax + 1000"]} />
          <Tooltip formatter={(value) => money(Math.round(Number(value) * 100))} />
          <Line type="monotone" dataKey="net" stroke="var(--color-pine)" strokeWidth={2.25} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AllocationChart({ slices }: { slices: { type: string; cents: number }[] }) {
  if (slices.length === 0) return <p className="text-sm text-muted">Add an included asset to see the mix.</p>;
  return (
    <div className="grid items-center gap-3 sm:grid-cols-[160px_1fr]">
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="cents" nameKey="type" innerRadius={42} outerRadius={64} stroke="none">
              {slices.map((slice, index) => (
                <Cell key={slice.type} fill={SLICE[index % SLICE.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-2">
        {slices.map((slice, index) => (
          <li key={slice.type} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ background: SLICE[index % SLICE.length] }} />
              {slice.type}
            </span>
            <span className="text-muted">{money(slice.cents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
