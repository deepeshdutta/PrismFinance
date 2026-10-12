export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function money(cents: number, digits?: number): string {
  const fraction = digits ?? (Math.abs(cents) % 100 === 0 ? 0 : 2);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  }).format(cents / 100);
}

export function signedMoney(cents: number): string {
  const body = money(Math.abs(cents));
  if (cents > 0) return `+${body}`;
  if (cents < 0) return `−${body}`;
  return body;
}

export const ASSET_TYPES = ["Checking", "Savings", "Brokerage", "Retirement", "Real estate", "Cash", "Other"] as const;
export const LIABILITY_TYPES = ["Credit card", "Mortgage", "Student loan", "Auto loan", "Other"] as const;
export const INVESTMENT_TYPES = ["Brokerage", "Retirement", "Real estate"] as const;
export const LOAN_TYPES = ["Mortgage", "Student loan", "Auto loan", "Credit card"] as const;
export const CATEGORIES = ["Pay", "Groceries", "Housing", "Utilities", "Transport", "Dining", "Healthcare", "Transfer", "Other"] as const;
