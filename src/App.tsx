import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { AllocationChart, TrendChart } from "./charts";
import {
  clearBooks,
  fetchOverview,
  loadSample,
  removeAccount,
  removeTransaction,
  saveAccount,
  saveTransaction,
  supabase,
  type AccountRow,
  type Overview,
} from "./lib/db";
import {
  ASSET_TYPES,
  CATEGORIES,
  INVESTMENT_TYPES,
  LIABILITY_TYPES,
  LOAN_TYPES,
  money,
  signedMoney,
  utcToday,
} from "./lib/money";

function useSession() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  return { user, ready };
}

function useBooks(signedIn: boolean) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!signedIn) return;
    try {
      setData(await fetchOverview());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your books");
    }
  }, [signedIn]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

const NAV = [
  { to: "/", label: "Overview", short: "Overview" },
  { to: "/investments", label: "Investments", short: "Invest" },
  { to: "/loans", label: "Loans", short: "Loans" },
  { to: "/cash", label: "Cash", short: "Cash" },
  { to: "/books", label: "Books", short: "Books" },
];

function Shell({ user, children }: { user: User | null; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col border-r border-line bg-card px-4 py-6 md:flex">
        <Brand />
        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `flex h-11 items-center rounded-xl px-3 text-sm ${isActive ? "bg-pine-soft text-pine" : ""}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="md:pl-56">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-paper/90 px-4 py-3 backdrop-blur">
          <div className="md:hidden">
            <Brand />
          </div>
          <p className="hidden text-sm text-muted md:block">Private books. Five people, separate numbers.</p>
          <div className="ml-auto text-sm">
            {user ? (
              <button type="button" className="text-muted" onClick={() => void supabase.auth.signOut()}>
                Sign out
              </button>
            ) : (
              <Link to="/login" className="text-pine">
                Sign in
              </Link>
            )}
          </div>
        </header>
        <main className="mx-auto w-full max-w-3xl px-4 py-5 pb-24">{children}</main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line bg-card md:hidden">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `flex h-14 items-center justify-center text-xs ${isActive ? "text-pine" : "text-muted"}`
            }
          >
            {item.short}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function Brand() {
  return (
    <Link to="/" className="block">
      <p className="font-display text-xl leading-none tracking-tight">PrismFinance</p>
      <p className="mt-1 text-xs tracking-wide text-muted uppercase">Net worth</p>
    </Link>
  );
}

function Welcome() {
  return (
    <section className="pt-6">
      <p className="text-xs tracking-wide text-muted uppercase">For a small circle</p>
      <h1 className="mt-2 font-display text-4xl leading-tight tracking-tight">What you own, what you owe, on one screen.</h1>
      <p className="mt-4 max-w-md text-sm text-muted">
        Each person signs in and sees only their own numbers. Built for about five people.
      </p>
      <Link to="/login" className="btn mt-6">
        Open your books
      </Link>
    </section>
  );
}

function Overview({ books }: { books: ReturnType<typeof useBooks> }) {
  const { data, error, reload } = books;
  const empty = data && data.accounts.length === 0;
  return (
    <div className="space-y-4">
      <section className="rounded-card bg-ink px-5 py-6 text-card">
        <p className="text-xs tracking-wide text-line uppercase">Net worth</p>
        <p className="mt-2 font-display text-5xl leading-none tracking-tight">{money(data?.netWorthCents ?? 0)}</p>
        <p className="mt-3 text-sm text-line">
          {data?.changeCents == null ? "Add a balance to start the line." : `${signedMoney(data.changeCents)} since the previous point`}
        </p>
      </section>
      {error ? <p className="text-sm text-clay">{error}</p> : null}
      <section className="grid grid-cols-3 gap-2">
        <Stat label="Assets" value={money(data?.assetsCents ?? 0)} />
        <Stat label="Owed" value={money(data?.liabilitiesCents ?? 0)} />
        <Stat label="This month" value={signedMoney((data?.monthInCents ?? 0) - (data?.monthOutCents ?? 0))} />
      </section>
      <section className="rounded-card border border-line bg-card p-4">
        <h2 className="text-sm font-medium">Net worth</h2>
        <TrendChart points={data?.trend ?? []} />
      </section>
      <section className="rounded-card border border-line bg-card p-4">
        <h2 className="mb-2 text-sm font-medium">Asset mix</h2>
        <AllocationChart slices={data?.allocation ?? []} />
      </section>
      {empty ? (
        <button type="button" className="btn" onClick={() => void loadSample().then(() => reload())}>
          Load a sample household
        </button>
      ) : data?.hasSample ? (
        <button type="button" className="btn-ghost" onClick={() => void clearBooks(true).then(() => reload())}>
          Remove sample
        </button>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-card px-3 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  );
}

function Holding({
  title,
  blurb,
  rows,
  onOpen,
}: {
  title: string;
  blurb: string;
  rows: AccountRow[];
  onOpen: (row: AccountRow) => void;
}) {
  const total = rows.reduce((sum, row) => (row.included ? sum + row.balanceCents : sum), 0);
  const types = [...new Set(rows.map((row) => row.accountType))];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-3xl tracking-tight">{title}</h1>
        <p className="text-sm text-muted">{blurb}</p>
        <p className="mt-2 text-2xl">{money(total)}</p>
      </div>
      {types.map((type) => (
        <section key={type}>
          <h2 className="mb-2 text-sm font-medium">{type}</h2>
          <ul className="divide-y divide-line rounded-card border border-line bg-card">
            {rows
              .filter((row) => row.accountType === type)
              .map((row) => (
                <li key={row.id}>
                  <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => onOpen(row)}>
                    <span className="text-sm">{row.name}</span>
                    <span className="text-sm">{money(row.balanceCents)}</span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
      {rows.length === 0 ? <p className="text-sm text-muted">None yet. Add one under Books.</p> : null}
    </div>
  );
}

function Books({ books }: { books: ReturnType<typeof useBooks> }) {
  const accounts = books.data?.accounts ?? [];
  const cash = accounts.filter((row) => row.kind === "asset" && ["Checking", "Savings", "Cash"].includes(row.accountType));
  const investments = accounts.filter((row) => row.kind === "asset" && (INVESTMENT_TYPES as readonly string[]).includes(row.accountType));
  const loans = accounts.filter((row) => row.kind === "liability" && (LOAN_TYPES as readonly string[]).includes(row.accountType));
  const listed = new Set([...cash, ...investments, ...loans].map((row) => row.id));
  const other = accounts.filter((row) => !listed.has(row.id));
  const [editing, setEditing] = useState<AccountRow | "asset" | "liability" | null>(null);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl tracking-tight">Books</h1>
        <p className="text-sm text-muted">Every balance lives here. Investments and loans also have their own pages.</p>
        <div className="mt-3 flex gap-2">
          <Link to="/investments" className="btn-ghost">
            Investments
          </Link>
          <Link to="/loans" className="btn-ghost">
            Loans
          </Link>
        </div>
      </div>
      {books.error ? <p className="text-sm text-clay">{books.error}</p> : null}
      <Group title="Cash" rows={cash} onOpen={setEditing} onAdd={() => setEditing("asset")} />
      <Group title="Investments" rows={investments} to="/investments" onOpen={setEditing} onAdd={() => setEditing("asset")} />
      <Group title="Loans" rows={loans} to="/loans" onOpen={setEditing} onAdd={() => setEditing("liability")} />
      {other.length > 0 ? <Group title="Other" rows={other} onOpen={setEditing} onAdd={() => setEditing("asset")} /> : null}
      {editing ? (
        <AccountForm
          seed={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void books.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function Group({
  title,
  rows,
  to,
  onOpen,
  onAdd,
}: {
  title: string;
  rows: AccountRow[];
  to?: string;
  onOpen: (row: AccountRow) => void;
  onAdd: () => void;
}) {
  const total = rows.reduce((sum, row) => (row.included ? sum + row.balanceCents : sum), 0);
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{to ? <Link to={to} className="text-pine">{title}</Link> : title}</h2>
        <span className="text-sm text-muted">{rows.length ? money(total) : ""}</span>
        <button type="button" className="text-sm text-pine" onClick={onAdd}>
          Add
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-card border border-dashed border-line px-4 py-6 text-sm text-muted">None yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-card">
          {rows.map((row) => (
            <li key={row.id}>
              <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => onOpen(row)}>
                <span>
                  <span className="block text-sm">{row.name}</span>
                  <span className="text-xs text-muted">
                    {row.accountType}
                    {row.institution ? ` · ${row.institution}` : ""}
                  </span>
                </span>
                <span className="text-sm">{money(row.balanceCents)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AccountForm({
  seed,
  onClose,
  onSaved,
}: {
  seed: AccountRow | "asset" | "liability";
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = typeof seed === "string" ? null : seed;
  const kind = existing?.kind ?? (seed === "liability" ? "liability" : "asset");
  const options = kind === "asset" ? ASSET_TYPES : LIABILITY_TYPES;
  const [name, setName] = useState(existing?.name ?? "");
  const [institution, setInstitution] = useState(existing?.institution ?? "");
  const [accountType, setAccountType] = useState(existing?.accountType ?? options[0]);
  const [balance, setBalance] = useState(existing ? String(existing.balanceCents / 100) : "");
  const [asOf, setAsOf] = useState(existing?.asOf ?? utcToday());
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const amount = Number(balance);
    if (!Number.isFinite(amount)) {
      setError("Enter a balance");
      return;
    }
    try {
      await saveAccount({
        id: existing?.id,
        kind,
        name,
        institution,
        accountType,
        balance: amount,
        included: true,
        asOf,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    }
  }
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/40 sm:items-center">
      <form onSubmit={onSubmit} className="w-full max-w-md space-y-3 rounded-t-2xl bg-paper p-5 sm:rounded-card">
        <h2 className="font-display text-2xl">{existing ? "Edit" : "Add"} {kind === "asset" ? "asset" : "loan"}</h2>
        <input className="field" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="field" placeholder="Institution" value={institution} onChange={(e) => setInstitution(e.target.value)} />
        <select className="field" value={accountType} onChange={(e) => setAccountType(e.target.value)}>
          {(existing && !options.includes(existing.accountType as never) ? [existing.accountType, ...options] : [...options]).map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
        <input className="field" inputMode="decimal" placeholder="Balance" value={balance} onChange={(e) => setBalance(e.target.value)} required />
        <input className="field" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
        {error ? <p className="text-sm text-clay">{error}</p> : null}
        <div className="flex gap-2">
          <button className="btn" type="submit">
            Save
          </button>
          {existing ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void removeAccount(existing.id).then(onSaved).catch((err) => setError(err instanceof Error ? err.message : "Could not delete"))}
            >
              Delete
            </button>
          ) : null}
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </form>
    </div>
  );
}

function Cash({ books }: { books: ReturnType<typeof useBooks> }) {
  const [open, setOpen] = useState(false);
  const recent = books.data?.recent ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Cash</h1>
          <p className="text-sm text-muted">Money in and out. This does not change account balances.</p>
        </div>
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Add
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="In" value={money(books.data?.monthInCents ?? 0)} />
        <Stat label="Out" value={money(books.data?.monthOutCents ?? 0)} />
      </div>
      {books.error ? <p className="text-sm text-clay">{books.error}</p> : null}
      <ul className="divide-y divide-line rounded-card border border-line bg-card">
        {recent.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <span>
              <span className="block text-sm">{row.merchant || row.category}</span>
              <span className="text-xs text-muted">
                {row.postedOn} · {row.category}
              </span>
            </span>
            <span className="flex items-center gap-3">
              <span className="text-sm">{row.direction === "in" ? "+" : "−"}{money(row.amountCents)}</span>
              <button type="button" className="text-xs text-muted" onClick={() => void removeTransaction(row.id).then(() => books.reload())}>
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      {recent.length === 0 ? <p className="text-sm text-muted">No cash entries yet.</p> : null}
      {open ? (
        <TxnForm
          accounts={books.data?.accounts ?? []}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            void books.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function TxnForm({
  accounts,
  onClose,
  onSaved,
}: {
  accounts: AccountRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [postedOn, setPostedOn] = useState(utcToday());
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"in" | "out">("out");
  const [category, setCategory] = useState<string>(CATEGORIES[1]);
  const [merchant, setMerchant] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter an amount greater than zero");
      return;
    }
    try {
      await saveTransaction({
        postedOn,
        amount: value,
        direction,
        category,
        merchant,
        isTransfer: category === "Transfer",
        accountId: accountId || null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    }
  }
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/40 sm:items-center">
      <form onSubmit={onSubmit} className="w-full max-w-md space-y-3 rounded-t-2xl bg-paper p-5 sm:rounded-card">
        <h2 className="font-display text-2xl">Add cash</h2>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={direction === "out" ? "btn" : "btn-ghost"} onClick={() => setDirection("out")}>
            Money out
          </button>
          <button type="button" className={direction === "in" ? "btn" : "btn-ghost"} onClick={() => setDirection("in")}>
            Money in
          </button>
        </div>
        <input className="field" inputMode="decimal" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <input className="field" type="date" value={postedOn} onChange={(e) => setPostedOn(e.target.value)} required />
        <select className="field" value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
        <input className="field" placeholder="Who" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
        <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">No account</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
        {error ? <p className="text-sm text-clay">{error}</p> : null}
        <div className="flex gap-2">
          <button className="btn" type="submit">
            Save
          </button>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </form>
    </div>
  );
}

function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNote(null);
    const result =
      mode === "up"
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
    setPending(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    if (mode === "up" && !result.data.session) {
      setNote("Check your email to confirm the account, then sign in.");
      setMode("in");
      return;
    }
    await navigate("/");
  }
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-10">
      <Link to="/" className="font-display text-3xl tracking-tight">
        PrismFinance
      </Link>
      <p className="mt-2 text-sm text-muted">Each person gets their own books. Nothing is shared.</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-3">
        <input className="field" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="field" type="password" placeholder="Password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error ? <p className="text-sm text-clay">{error}</p> : null}
        {note ? <p className="text-sm text-muted">{note}</p> : null}
        <button className="btn w-full" type="submit" disabled={pending}>
          {pending ? "Working…" : mode === "up" ? "Create account" : "Sign in"}
        </button>
        <button
          type="button"
          className="text-sm text-muted"
          onClick={() => {
            setMode(mode === "up" ? "in" : "up");
            setError(null);
          }}
        >
          {mode === "up" ? "Already have an account? Sign in" : "New here? Create an account"}
        </button>
      </form>
    </main>
  );
}

export default function App() {
  const { user, ready } = useSession();
  const books = useBooks(Boolean(user));
  const [editing, setEditing] = useState<AccountRow | null>(null);
  if (!ready) return <p className="p-6 text-sm text-muted">Loading…</p>;
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="*"
        element={
          <Shell user={user}>
            {!user ? (
              <Welcome />
            ) : (
              <Routes>
                <Route path="/" element={<Overview books={books} />} />
                <Route
                  path="/investments"
                  element={
                    <Holding
                      title="Investments"
                      blurb="Brokerage, retirement, and property."
                      rows={(books.data?.accounts ?? []).filter(
                        (row) => row.kind === "asset" && (INVESTMENT_TYPES as readonly string[]).includes(row.accountType),
                      )}
                      onOpen={setEditing}
                    />
                  }
                />
                <Route
                  path="/loans"
                  element={
                    <Holding
                      title="Loans"
                      blurb="Mortgage, student, auto, and cards."
                      rows={(books.data?.accounts ?? []).filter(
                        (row) => row.kind === "liability" && (LOAN_TYPES as readonly string[]).includes(row.accountType),
                      )}
                      onOpen={setEditing}
                    />
                  }
                />
                <Route path="/cash" element={<Cash books={books} />} />
                <Route path="/books" element={<Books books={books} />} />
              </Routes>
            )}
            {editing ? (
              <AccountForm
                seed={editing}
                onClose={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  void books.reload();
                }}
              />
            ) : null}
          </Shell>
        }
      />
    </Routes>
  );
}
