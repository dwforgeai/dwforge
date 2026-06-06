export default async function handler(req, res) {

  // Security headers on every response
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { prompt } = req.body;

    // Validate input — never log payload contents
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    if (prompt.length > 8000) {
      return res.status(400).json({ error: 'Prompt too long. Please simplify your request.' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Service configuration error. Please try again later.' });
    }

    const systemPrompt = `You are a senior MuleSoft integration architect generating production DataWeave 2.0 code.

STRICT SYNTAX RULES — every rule is mandatory:

RULE 1: Always start with exactly these three lines, nothing before them:
%dw 2.0
output application/json
---

RULE 2: SINGLE record transformation — access payload fields directly:
%dw 2.0
output application/json
---
{
  targetField: payload.sourceField default ""
}

RULE 3: BATCH transformation — use map on the array:
%dw 2.0
output application/json
---
payload map (item) -> {
  targetField: item.sourceField default ""
}

RULE 4: FILTER + MAP — NEVER chain directly. Always use var:
WRONG: payload filter (...) map (...) -> { }
CORRECT:
%dw 2.0
output application/json
var validRecords = payload filter (item) -> (item.id != null)
---
validRecords map (item) -> {
  targetField: item.sourceField default ""
}

RULE 5: SKIP RECORD when field is null — return empty object for single record:
%dw 2.0
output application/json
---
if (payload.keyField != null)
  { targetField: payload.keyField }
else {}

RULE 6: NULL HANDLING — always use default keyword:
field: payload.sourceField default ""
field: payload.sourceField default 0
field: payload.sourceField default false

RULE 7: DATE TO ISO 8601 — always cast to String first:
StartDate: if (payload.StartDate__c != null) (payload.StartDate__c as String) ++ "T00:00:00Z" else null

RULE 8: SALESFORCE RELATIONSHIPS — use safe navigation:
CustomerAccount: payload.Account__r.ERP_ID__c default ""

RULE 9: DREMIO — if source or target is Dremio:
- REST API responses use { schema: [...], rows: [...] } structure
- Access rows as payload.rows map (row) -> { ... }
- Column values accessed by index: row[0], row[1] etc.
- Job submission format: { sql: "SELECT ...", context: ["schema"] }

RULE 10: OUTPUT pure DataWeave ONLY — zero backticks, zero markdown, zero code fences.
The very first character of your response must be % from %dw 2.0.

RULE 11: Add inline comments for non-obvious logic only.

RULE 12: Code must compile and run in MuleSoft DataWeave Playground without modification.

After the complete DataWeave code, write exactly "EXPLANATION:" on a new line.
Then write 2-3 plain English sentences: what the transformation does, key decisions made, and one thing to verify before deploying.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const status = response.status;
      const errMsg = error.error?.message || '';

      if (status === 401) {
        return res.status(500).json({ error: 'Service authentication error. Please try again later.' });
      }
      if (status === 429) {
        if (errMsg.toLowerCase().includes('credit') || errMsg.toLowerCase().includes('balance') || errMsg.toLowerCase().includes('quota')) {
          return res.status(429).json({ error: 'DWForge has reached its daily limit. We are topping up — please check back in a few hours.' });
        }
        return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
      }
      if (status === 529 || status === 503) {
        return res.status(503).json({ error: 'Service temporarily busy. Please try again in a few seconds.' });
      }
      if (status === 402) {
        return res.status(503).json({ error: 'DWForge has reached its daily limit. We are topping up — please check back in a few hours.' });
      }

      return res.status(status).json({
        error: 'Generation failed. Please try again.'
      });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    // Log only that an error occurred — never log payload contents
    console.error('DWForge generate error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
