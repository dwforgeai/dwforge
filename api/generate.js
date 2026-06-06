export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Limit prompt size to prevent abuse
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

RULE 5: SKIP RECORD when field is null — use filter with var as shown in RULE 4.
If transforming a single record and the key field is null, return an empty object:
%dw 2.0
output application/json
---
if (payload.keyField != null)
  { targetField: payload.keyField }
else {}

RULE 6: NULL HANDLING — always use default keyword:
field: payload.sourceField default ""       // for strings
field: payload.sourceField default 0        // for numbers
field: payload.sourceField default false    // for booleans

RULE 7: DATE TO ISO 8601 — always cast to String first:
StartDate: if (payload.StartDate__c != null) (payload.StartDate__c as String) ++ "T00:00:00Z" else null

RULE 8: SALESFORCE RELATIONSHIPS — use safe navigation:
CustomerAccount: payload.Account__r.ERP_ID__c default ""

RULE 9: OUTPUT pure DataWeave ONLY — zero backticks, zero markdown, zero code fences, zero language tags.
The very first character of your response must be % from %dw 2.0.

RULE 10: Add inline comments for non-obvious logic only — keep it concise.

RULE 11: Code must compile and run in MuleSoft DataWeave Playground without any modification.

After the complete DataWeave code, write exactly "EXPLANATION:" on a new line.
Then write 2-3 plain English sentences: what the transformation does, key decisions made, and one thing the developer should verify before deploying.`;

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

      if (status === 401) {
        return res.status(500).json({ error: 'Service authentication error. Please try again later.' });
      }
      if (status === 429) {
        return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
      }
      if (status === 529 || status === 503) {
        return res.status(503).json({ error: 'Service temporarily busy. Please try again in a few seconds.' });
      }

      return res.status(status).json({
        error: error.error?.message || 'Generation failed. Please try again.'
      });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    console.error('DWForge generate error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
