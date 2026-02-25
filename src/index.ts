import * as fs from "fs";
import * as path from "path";

const BASE_URL = "https://api.monzo.com";
const TMP_DIR = path.join(__dirname, "..", "tmp");
const STATE_PATH = path.join(TMP_DIR, "state.json");
const TRANSACTIONS_PATH = path.join(TMP_DIR, "transactions.json");
const CSV_DIR = path.join(TMP_DIR, "transactions");
const CREDENTIALS_PATH = path.join(__dirname, "..", "credentials.json");
const PAGE_SIZE = 100;

const EPOCH = "2015-01-01T00:00:00Z";

interface State {
  accountId: string;
  since: string; // transaction ID or timestamp to resume from
  done: boolean;
}

interface Transaction {
  id: string;
  created: string;
  amount: number;
  currency: string;
  description: string;
  category: string;
  notes: string;
  merchant: { name: string } | null;
  metadata: Record<string, string>;
  scheme: string;
  is_load: boolean;
}

function readAccessToken(): string {
  const { accessToken } = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  if (!accessToken) throw new Error("accessToken not found in credentials.json");
  return accessToken;
}

function loadState(): State | null {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  }
  return null;
}

function saveState(state: State): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadTransactions(): Transaction[] {
  if (fs.existsSync(TRANSACTIONS_PATH)) {
    return JSON.parse(fs.readFileSync(TRANSACTIONS_PATH, "utf-8"));
  }
  return [];
}

function saveTransactions(transactions: Transaction[]): void {
  fs.writeFileSync(TRANSACTIONS_PATH, JSON.stringify(transactions, null, 2));
}

async function monzoGet(
  endpoint: string,
  token: string,
  params: Record<string, string> = {}
): Promise<any> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after")) || 2 ** attempt;
      console.log(`Rate limited. Retrying in ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (response.status === 403) {
      const body = await response.text();
      if (body.includes("verification_required")) {
        console.log("Verification required — please approve in the Monzo app... (waiting 10s)");
        await sleep(10000);
        attempt--; // don't count verification waits against retry limit
        continue;
      }
      throw new Error(`API error ${response.status}: ${body}`);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`API error ${response.status}: ${body}`);
    }

    return response.json();
  }

  throw new Error("Max retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAccountId(token: string): Promise<string> {
  const data = await monzoGet("/accounts", token, {
    account_type: "uk_retail",
  });
  const accounts = data.accounts;
  if (!accounts || accounts.length === 0) {
    throw new Error("No uk_retail account found");
  }
  return accounts[0].id;
}

const WINDOW_MS = 364 * 24 * 60 * 60 * 1000; // 364 days (API max is 8760h = 365 days)

function timeWindowsFrom(since: string): Array<{ since: string; before: string }> {
  const start = new Date(since);
  const now = new Date();
  const windows: Array<{ since: string; before: string }> = [];

  let cursor = start;
  while (cursor < now) {
    const end = new Date(Math.min(cursor.getTime() + WINDOW_MS, now.getTime()));
    windows.push({
      since: cursor.toISOString(),
      before: end.toISOString(),
    });
    cursor = end;
  }
  return windows;
}

async function downloadTransactions(
  token: string,
  state: State,
  allTransactions: Transaction[]
): Promise<void> {
  console.log(`Fetching from ${state.since} (${allTransactions.length} cached)...`);

  // If we already have a transaction ID as the cursor, just paginate forward
  // (no year-window needed since the API accepts transaction IDs without time range limits)
  if (state.since.startsWith("tx_")) {
    await fetchPage(token, state, allTransactions);
    return;
  }

  // Otherwise walk forward in yearly windows from the timestamp
  const windows = timeWindowsFrom(state.since);
  for (const window of windows) {
    console.log(`\nWindow: ${window.since.slice(0, 10)} → ${window.before.slice(0, 10)}`);
    let since = window.since;

    while (true) {
      const params: Record<string, string> = {
        account_id: state.accountId,
        limit: String(PAGE_SIZE),
        "expand[]": "merchant",
        since: since,
        before: window.before,
      };

      const data = await monzoGet("/transactions", token, params);
      const transactions: Transaction[] = data.transactions;

      if (!transactions || transactions.length === 0) {
        break;
      }

      allTransactions.push(...transactions);
      const lastTxn = transactions[transactions.length - 1];
      since = lastTxn.id;
      state.since = since;

      saveTransactions(allTransactions);
      saveState(state);

      console.log(
        `  ${transactions.length} txns (total: ${allTransactions.length}, latest: ${lastTxn.created})`
      );

      if (transactions.length < PAGE_SIZE) {
        break;
      }

      await sleep(300);
    }
  }

  // Now continue forward from last transaction ID to pick up anything new
  if (allTransactions.length > 0) {
    state.since = allTransactions[allTransactions.length - 1].id;
    saveState(state);
    await fetchPage(token, state, allTransactions);
  }

  state.done = true;
  saveState(state);
}

async function fetchPage(
  token: string,
  state: State,
  allTransactions: Transaction[]
): Promise<void> {
  let since = state.since;

  while (true) {
    const params: Record<string, string> = {
      account_id: state.accountId,
      limit: String(PAGE_SIZE),
      "expand[]": "merchant",
      since: since,
    };

    const data = await monzoGet("/transactions", token, params);
    const transactions: Transaction[] = data.transactions;

    if (!transactions || transactions.length === 0) {
      console.log("Up to date.");
      break;
    }

    allTransactions.push(...transactions);
    const lastTxn = transactions[transactions.length - 1];
    since = lastTxn.id;
    state.since = since;

    saveTransactions(allTransactions);
    saveState(state);

    console.log(
      `  ${transactions.length} txns (total: ${allTransactions.length}, latest: ${lastTxn.created})`
    );

    if (transactions.length < PAGE_SIZE) {
      break;
    }

    await sleep(300);
  }
}

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function generateCSVs(transactions: Transaction[]): void {
  fs.mkdirSync(CSV_DIR, { recursive: true });

  const byMonth = new Map<string, Transaction[]>();

  for (const txn of transactions) {
    const month = txn.created.slice(0, 7); // YYYY-MM
    if (!byMonth.has(month)) {
      byMonth.set(month, []);
    }
    byMonth.get(month)!.push(txn);
  }

  const header = "date,time,type,description,amount,currency,category,notes";

  for (const [month, txns] of byMonth) {
    txns.sort(
      (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime()
    );

    const rows = txns.map((txn) => {
      const dt = new Date(txn.created);
      const date = dt.toISOString().slice(0, 10);
      const time = dt.toISOString().slice(11, 19);
      const description = txn.merchant?.name || txn.description;
      const amount = (txn.amount / 100).toFixed(2);

      return [
        date,
        time,
        escapeCSV(txn.category),
        escapeCSV(description),
        amount,
        txn.currency,
        escapeCSV(txn.category),
        escapeCSV(txn.notes || ""),
      ].join(",");
    });

    const csv = [header, ...rows].join("\n") + "\n";
    const filePath = path.join(CSV_DIR, `${month}.csv`);
    fs.writeFileSync(filePath, csv);
    console.log(`Wrote ${filePath} (${txns.length} transactions)`);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const token = readAccessToken();
  let state = loadState();

  if (!state) {
    console.log("Fetching account ID...");
    const accountId = await fetchAccountId(token);
    state = { accountId, since: EPOCH, done: false };
    saveState(state);
    console.log(`Account ID: ${accountId}`);
  } else {
    console.log(`Resuming with account ${state.accountId}`);
  }

  const allTransactions = loadTransactions();
  await downloadTransactions(token, state, allTransactions);
  const transactions = allTransactions;

  if (transactions.length === 0) {
    console.log("No transactions to export.");
    return;
  }

  console.log(`\nGenerating CSVs for ${transactions.length} transactions...`);
  generateCSVs(transactions);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
