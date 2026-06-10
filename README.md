# DWForge

**DWForge** is an AI-powered tool that generates production-ready [DataWeave](https://docs.mulesoft.com/dataweave/latest/) transformation code for MuleSoft integrations — built by a senior integration architect who got tired of writing it by hand.

## What It Does

DataWeave is notoriously tricky to get right. Field mappings, date formats, padding rules, null handling, connector-specific quirks — every integration pattern has its own landmines. DWForge encodes that hard-won knowledge and uses it to generate accurate, production-grade DataWeave scripts in seconds.

You describe your integration (source system, target system, payload shape), and DWForge outputs transformation code you can drop straight into Anypoint Studio — no guesswork, no debugging edge cases from scratch.

## Supported Integration Patterns

| Source | Target |
|---|---|
| Salesforce | NetSuite |
| Salesforce | SAP |
| Salesforce | Dynamics 365 |
| Salesforce | ServiceNow |
| Salesforce | Workday |
| SAP | Salesforce |
| Workday | Salesforce |
| Dynamics 365 | Salesforce |

## Key Features

- **Pattern-aware generation** — each integration pattern encodes system-specific rules (SAP field padding, NetSuite date formats, Workday array handling, etc.)
- **Production-ready output** — generated code handles nulls, empty arrays, type coercions, and edge cases out of the box
- **Validator** — built-in validation layer checks generated DataWeave before it reaches your hands
- **Mule flow automation** *(in progress)* — automatic generation of full MuleSoft flow XML, not just the DataWeave transform

## Tech Stack

- **Frontend** — Vanilla HTML/CSS/JS
- **Backend** — Node.js serverless API (Vercel)
- **AI** — Anthropic Claude for code generation, guided by a curated knowledge corpus of integration patterns
- **Deployment** — Vercel

## Project Structure

```
├── index.html          # Landing page
├── tool.html           # Main generation UI
├── pricing.html        # Pricing page
├── api/
│   ├── generate.js     # Core generation API (Claude + RAG patterns)
│   ├── validator.js    # Output validation
│   └── patterns/       # Per-integration knowledge patterns (JSON)
├── articles/           # Integration guides and tutorials
└── skills/
    └── SKILL.md        # AI skill definition for generation behaviour
```

## Status

Active development. The `feature/add-mule-flow-automation` branch is extending the tool to generate complete Mule flow XML alongside DataWeave transformations.
