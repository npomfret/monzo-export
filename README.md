# Monzo Export

Download Monzo transaction data and save as monthly CSV files.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Create a `credentials.json` file in the project root:
   ```json
   {
     "userId": "user_...",
     "accountId": "",
     "accessToken": "your-access-token"
   }
   ```

   Get your access token from the [Monzo Developer Playground](https://developers.monzo.com/).

## Usage

```
npm start
```

Or directly:

```
npx tsx src/index.ts
```

On first run, the script will:
1. Fetch your account ID
2. Download all transactions from 2015 onwards in yearly windows
3. Generate monthly CSV files

For older transactions, Monzo may ask you to **approve access in the Monzo app** — check for a notification.

## Resuming

The script saves progress after each batch. If interrupted, re-run and it picks up where it left off. Delete `tmp/` to start fresh.

## Output

```
tmp/
  state.json              # resume state
  transactions.json       # all raw transactions
  transactions/
    2018-06.csv
    2018-07.csv
    ...
```

CSV columns: `date, time, type, description, amount, currency, category, notes`
