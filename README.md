# mony-home

Self-hosted household finance web platform for a single household (2-6 users).

## Setup

```bash
cp .env.example .env.local
npm install
```

## Commands

```bash
npm run dev        # start the dev server
npm run verify     # lint + typecheck + test + build (must pass before every push)
```

## Configuration

All runtime configuration is environment-driven and validated with zod in
`src/lib/config.ts`. See `.env.example` for every variable and its purpose.
Config parsing is lazy: the build never requires optional variables, but using
the config with an invalid state throws an error naming the offending variable.
