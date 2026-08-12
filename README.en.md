# TodoList AI

I build and use this app myself, and it's still growing. If you run into problems, have ideas, or want it to work the way you need, talk to me. Email me at ezra.y.franklin@gmail.com, or open an issue or start a discussion on GitHub. The thing a one-person project needs most is someone telling you what's wrong.

An AI to-do app for macOS. Unlike a plain to-do list, every morning at 8 it looks at your open tasks, calendar, and inbox, and lays out today into time blocks for you to approve. At 9 in the evening it reviews the day and carries unfinished tasks over to tomorrow.

All data lives in a local SQLite database. Use a cloud model if you want, or go fully local with Ollama and nothing ever leaves your machine.

<p align="center">
  <img src="docs/screenshots/home.png" width="720" alt="Today view: AI assistant plus today's time blocks" />
</p>

## What it looks like

The top of the today view is an AI assistant. Just talk to it in plain language and it does the work.

<p align="center">
  <img src="docs/screenshots/calendar.png" width="720" alt="Calendar: dots mark days that have plans or tasks" />
</p>

Days with a dot on the calendar have a plan or tasks. Click through to add, edit, or delete per day.

<p align="center">
  <img src="docs/screenshots/settings.png" width="720" alt="Settings: AI provider and API key configuration" />
</p>

The settings page lets you switch AI providers, paste your own API key, or point to a local Ollama instance.

## Features

- **Inbox capture**. Press ⌘K, jot something down, let the AI sort it later
- **Conversational home**. Say things like "add a task: buy coffee", "move XX to tomorrow", "mark XX done", and the AI updates the database. Falls back to keyword commands when no model is configured
- **Daily auto-planning**. Generates today's plan at 08:00 as a draft, writes back after you confirm
- **Plan review and editing**. Drag to reorder time blocks, add or remove tasks
- **Execution and tracking**. Check things off, watch the progress bar
- **Evening review**. At 21:00 it summarizes what got done and carries unfinished tasks forward
- **Web search**. The AI searches DuckDuckGo when answering, falling back to Google / Bing
- **Local-first**. SQLite storage, Ollama privacy mode, nothing leaves the machine unless you configure a cloud provider

## Getting started

Requires Node.js, Rust, and macOS.

```bash
npm install
npm run tauri dev    # development
npm run tauri build  # package a DMG
```

Local model (recommended, private):

```bash
ollama serve
ollama pull qwen2.5:7b
```

Then switch the provider to Ollama in settings.

### Cloud models

The Base URL field in settings is open. Use `https://api.openai.com/v1` for OpenAI, `https://api.deepseek.com` for DeepSeek, or any OpenAI-compatible endpoint. Model names are free-form, e.g. `deepseek-chat`, `deepseek-reasoner`, `gpt-4o-mini`. The API key is stored only in your local SQLite.

## Privacy

No accounts, no ads, no telemetry SDK. Data stays on your machine by default.

| Item | Details |
|------|---------|
| Local data | SQLite at `~/Library/Application Support/com.todolistai.app/todolist.db` |
| API key | Stored only in the local SQLite `settings` table, plain text, never uploaded |
| `agent_runs` log | Local record of AI prompts and outputs, used only for prompt iteration |
| Cloud models | When a cloud provider is configured, conversation content is sent to that provider. With local Ollama, nothing is sent |
| Web search | Search terms go to DuckDuckGo, falling back to Google / Bing |
| System bridge | Reads Apple Reminders via `remindctl`, read-only, needs system permission (in development) |

Privacy-sensitive spots in the code are annotated with `隐私:` comments.

## License and commercial use

Licensed under the **PolyForm Noncommercial License 1.0.0** (see `LICENSE`).

- ✅ Personal study, research, self-use, and sharing of derivatives are fine. Non-commercial organizations such as charities, schools, research institutions, and governments may also use it
- ❌ No commercial monetization. That includes selling the software or derivatives, paid hosting / SaaS, embedding the code in commercial products, and paid training or consulting

For commercial use, contact the author for a separate license.

## Tech stack

| Layer | Choice |
|-------|--------|
| Shell | Tauri v2 (Rust backend only wires up official plugins) |
| Frontend | React 19 + Vite 7 + TypeScript + Tailwind CSS v4 |
| UI | shadcn/ui + lucide-react + dnd-kit + sonner |
| State | Zustand + TanStack Query |
| Data | SQLite (tauri-plugin-sql) + Drizzle |
| AI | Vercel AI SDK (OpenAI/Anthropic) + custom Ollama structured generator |

## Tests

`tests/` contains an end-to-end suite that drives real AI CRUD with a real model and verifies each step directly against the database, never trusting the model's reply.

```bash
node tests/run-agent-crud.mjs
```

10 cases: create, query, reschedule, complete, delete, delete-guard, no-false-report, batch delete by range, batch delete all, and live web search.
