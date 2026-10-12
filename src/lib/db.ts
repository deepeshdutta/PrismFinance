import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { utcToday } from "./money";

const url = "https://gsvfzjuktwowliycqvpw.supabase.co";
const anon = "sb_publishable_ZlutyRiNNIX-10buCaVbyA_8jGlndXU";

export const supabase = createClient(url, anon);

export type AccountRow = {
  id: string;
  kind: "asset" | "liability";
  name: string;
  institution: string;
  accountType: string;
  balanceCents: number;
  included: boolean;
  asOf: string;
  isSample: boolean;
};

export type TxnRow = {
  id: string;
  accountId: string | null;
  postedOn: string;
  amountCents: number;
  direction: "in" | "out";
  category: string;
  merchant: string;
  isTransfer: boolean;
  isSample: boolean;
};

export type Overview = {
  assetsCents: number;
  liabilitiesCents: number;
  netWorthCents: number;
  monthInCents: number;
  monthOutCents: number;
  changeCents: number | null;
  allocation: { type: string; cents: number }[];
  trend: { asOf: string; netCents: number }[];
  accounts: AccountRow[];
  recent: TxnRow[];
  hasSample: boolean;
};

type AccountRecord = {
  id: string;
  kind: "asset" | "liability";
  name: string;
  institution: string;
  account_type: string;
  balance_cents: number;
  included: boolean;
  as_of: string;
  is_sample: boolean;
};

type TxnRecord = {
  id: string;
  account_id: string | null;
  posted_on: string;
  amount_cents: number;
  direction: "in" | "out";
  category: string;
  merchant: string;
  is_transfer: boolean;
  is_sample: boolean;
};

function fail(error: { message: string } | null) {
  if (!error) return;
  const locked = /row-level security|permission denied/i.test(error.message);
  throw new Error(
    locked
      ? "Supabase is still blocking this sign-in. Run supabase/policies.sql in the SQL editor, then try again."
      : error.message,
  );
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function day(value: unknown): string {
  return String(value).slice(0, 10);
}

function toAccount(row: AccountRecord): AccountRow {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    institution: row.institution,
    accountType: row.account_type,
    balanceCents: num(row.balance_cents),
    included: row.included,
    asOf: day(row.as_of),
    isSample: row.is_sample,
  };
}

async function userId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("Sign in again.");
  return data.user.id;
}

async function snapshot(db: SupabaseClient, id: string) {
  const { data, error } = await db.from("prism_accounts").select("kind,balance_cents,included").eq("user_id", id);
  fail(error);
  let assets = 0;
  let liabilities = 0;
  for (const row of data ?? []) {
    if (!row.included) continue;
    if (row.kind === "asset") assets += num(row.balance_cents);
    else liabilities += num(row.balance_cents);
  }
  const saved = await db.from("prism_net_worth_points").upsert(
    { user_id: id, as_of: utcToday(), assets_cents: assets, liabilities_cents: liabilities },
    { onConflict: "user_id,as_of" },
  );
  fail(saved.error);
}

export async function fetchOverview(): Promise<Overview> {
  const id = await userId();
  const db = supabase;
  const accountsResult = await db
    .from("prism_accounts")
    .select("id,kind,name,institution,account_type,balance_cents,included,as_of,is_sample")
    .eq("user_id", id)
    .order("kind")
    .order("name");
  fail(accountsResult.error);
  const accounts = ((accountsResult.data ?? []) as AccountRecord[]).map(toAccount);

  const txnResult = await db
    .from("prism_transactions")
    .select("id,account_id,posted_on,amount_cents,direction,category,merchant,is_transfer,is_sample")
    .eq("user_id", id)
    .order("posted_on", { ascending: false })
    .limit(40);
  fail(txnResult.error);
  const recent: TxnRow[] = ((txnResult.data ?? []) as TxnRecord[]).map((row) => ({
    id: row.id,
    accountId: row.account_id,
    postedOn: day(row.posted_on),
    amountCents: num(row.amount_cents),
    direction: row.direction,
    category: row.category,
    merchant: row.merchant,
    isTransfer: row.is_transfer,
    isSample: row.is_sample,
  }));

  const monthStart = `${utcToday().slice(0, 8)}01`;
  const monthResult = await db
    .from("prism_transactions")
    .select("amount_cents,direction")
    .eq("user_id", id)
    .eq("is_transfer", false)
    .gte("posted_on", monthStart);
  fail(monthResult.error);
  let monthInCents = 0;
  let monthOutCents = 0;
  for (const row of monthResult.data ?? []) {
    if (row.direction === "in") monthInCents += num(row.amount_cents);
    else monthOutCents += num(row.amount_cents);
  }

  const pointResult = await db
    .from("prism_net_worth_points")
    .select("as_of,assets_cents,liabilities_cents")
    .eq("user_id", id)
    .order("as_of");
  fail(pointResult.error);

  let assetsCents = 0;
  let liabilitiesCents = 0;
  const byType = new Map<string, number>();
  for (const account of accounts) {
    if (!account.included) continue;
    if (account.kind === "asset") {
      assetsCents += account.balanceCents;
      byType.set(account.accountType, (byType.get(account.accountType) ?? 0) + account.balanceCents);
    } else {
      liabilitiesCents += account.balanceCents;
    }
  }
  const trend = (pointResult.data ?? []).map((point) => ({
    asOf: day(point.as_of),
    netCents: num(point.assets_cents) - num(point.liabilities_cents),
  }));
  const netWorthCents = assetsCents - liabilitiesCents;
  if (trend.length === 0) trend.push({ asOf: utcToday(), netCents: netWorthCents });
  const previous = trend.length > 1 ? trend[trend.length - 2]?.netCents : null;
  return {
    assetsCents,
    liabilitiesCents,
    netWorthCents,
    monthInCents,
    monthOutCents,
    changeCents: previous == null ? null : netWorthCents - previous,
    allocation: [...byType.entries()].map(([type, cents]) => ({ type, cents })).sort((a, b) => b.cents - a.cents),
    trend,
    accounts,
    recent,
    hasSample: accounts.some((account) => account.isSample) || recent.some((txn) => txn.isSample),
  };
}

export async function saveAccount(input: {
  id?: string;
  kind: "asset" | "liability";
  name: string;
  institution: string;
  accountType: string;
  balance: number;
  included: boolean;
  asOf: string;
}) {
  const id = await userId();
  const db = supabase;
  const row = {
    kind: input.kind,
    name: input.name,
    institution: input.institution,
    account_type: input.accountType,
    balance_cents: Math.round(input.balance * 100),
    included: input.included,
    as_of: input.asOf,
    is_sample: false,
  };
  if (input.id) {
    const updated = await db.from("prism_accounts").update(row).eq("id", input.id).eq("user_id", id).select("id");
    fail(updated.error);
    if (!updated.data?.length) throw new Error("That account is not on your books");
  } else {
    const inserted = await db.from("prism_accounts").insert({ id: crypto.randomUUID(), user_id: id, ...row });
    fail(inserted.error);
  }
  await snapshot(db, id);
}

export async function removeAccount(accountId: string) {
  const id = await userId();
  const db = supabase;
  fail((await db.from("prism_accounts").delete().eq("id", accountId).eq("user_id", id)).error);
  fail((await db.from("prism_transactions").update({ account_id: null }).eq("account_id", accountId).eq("user_id", id)).error);
  await snapshot(db, id);
}

export async function saveTransaction(input: {
  postedOn: string;
  amount: number;
  direction: "in" | "out";
  category: string;
  merchant: string;
  isTransfer: boolean;
  accountId: string | null;
}) {
  const id = await userId();
  const db = supabase;
  if (input.accountId) {
    const owned = await db.from("prism_accounts").select("id").eq("id", input.accountId).eq("user_id", id);
    fail(owned.error);
    if (!owned.data?.length) throw new Error("Pick one of your accounts");
  }
  const inserted = await db.from("prism_transactions").insert({
    id: crypto.randomUUID(),
    user_id: id,
    account_id: input.accountId,
    posted_on: input.postedOn,
    amount_cents: Math.round(input.amount * 100),
    direction: input.direction,
    category: input.category,
    merchant: input.merchant,
    is_transfer: input.isTransfer,
    is_sample: false,
  });
  fail(inserted.error);
}

export async function removeTransaction(txnId: string) {
  const id = await userId();
  fail((await supabase.from("prism_transactions").delete().eq("id", txnId).eq("user_id", id)).error);
}

export async function loadSample() {
  const id = await userId();
  const db = supabase;
  fail((await db.from("prism_transactions").delete().eq("user_id", id).eq("is_sample", true)).error);
  fail((await db.from("prism_accounts").delete().eq("user_id", id).eq("is_sample", true)).error);
  const rows: Array<[string, "asset" | "liability", string, string, string, number]> = [
    ["Checking", "asset", "Everyday checking", "First National", "Checking", 842055],
    ["Savings", "asset", "Reserve savings", "First National", "Savings", 2260000],
    ["Brokerage", "asset", "Taxable brokerage", "Northline", "Brokerage", 8640000],
    ["Retirement", "asset", "Retirement", "Northline", "Retirement", 14125000],
    ["Home", "asset", "Oak Street home", "Self", "Real estate", 42000000],
    ["Card", "liability", "Harbor card", "Harbor", "Credit card", 318000],
    ["Mortgage", "liability", "Oak Street mortgage", "First National", "Mortgage", 28640000],
  ];
  const today = utcToday();
  const ids = new Map<string, string>();
  const accountRows = rows.map(([key, kind, name, institution, accountType, balanceCents]) => {
    const accountId = crypto.randomUUID();
    ids.set(key, accountId);
    return {
      id: accountId,
      user_id: id,
      kind,
      name,
      institution,
      account_type: accountType,
      balance_cents: balanceCents,
      included: true,
      as_of: today,
      is_sample: true,
    };
  });
  fail((await db.from("prism_accounts").insert(accountRows)).error);
  const txns: Array<[string, number, "in" | "out", string, string, boolean]> = [
    ["Checking", 640000, "in", "Pay", "Northwind", false],
    ["Checking", 18640, "out", "Groceries", "Market", false],
    ["Checking", 214000, "out", "Housing", "First National", false],
    ["Card", 6420, "out", "Dining", "Corner cafe", false],
    ["Checking", 40000, "out", "Transfer", "Reserve savings", true],
  ];
  fail(
    (
      await db.from("prism_transactions").insert(
        txns.map(([key, amountCents, direction, category, merchant, isTransfer]) => ({
          id: crypto.randomUUID(),
          user_id: id,
          account_id: ids.get(key) ?? null,
          posted_on: today,
          amount_cents: amountCents,
          direction,
          category,
          merchant,
          is_transfer: isTransfer,
          is_sample: true,
        })),
      )
    ).error,
  );
  await snapshot(db, id);
}

export async function clearBooks(sampleOnly: boolean) {
  const id = await userId();
  const db = supabase;
  if (sampleOnly) {
    fail((await db.from("prism_transactions").delete().eq("user_id", id).eq("is_sample", true)).error);
    fail((await db.from("prism_accounts").delete().eq("user_id", id).eq("is_sample", true)).error);
  } else {
    fail((await db.from("prism_transactions").delete().eq("user_id", id)).error);
    fail((await db.from("prism_accounts").delete().eq("user_id", id)).error);
    fail((await db.from("prism_net_worth_points").delete().eq("user_id", id)).error);
  }
  await snapshot(db, id);
}
