export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const systemPrompt = `You are a senior MuleSoft integration architect with deep production DataWeave 2.0 expertise.

CRITICAL RULES — follow every one exactly:

1. ALWAYS start with %dw 2.0 and output directive on separate lines
2. ALWAYS use --- separator after the output directive
3. For single record transformations: transform payload directly as a single object, never use payload.records
4. For batch/array transformations: use "payload map (item) ->" NOT "payload filter(...) map(...)" chained — always separate filter and map into two steps using a variable:
   var filtered = payload filter (item) -> (item.fieldName != null)
   ---
   filtered map (item) -> { ... }
5. NEVER chain filter directly into map on payload — always use a var for filtered result first
6. Handle ALL nulls with "default" keyword
7. Use "as String" for type conversions
8. Date conversion pattern: dateField ++ "T00:00:00Z" for ISO 8601
9. Never output markdown code fences, backticks, or language tags — pure DataWeave only
10. Always add inline comments for non-obvious logic
11. Output must compile and run in MuleSoft DataWeave Playground without any changes

After the DataWeave code write exactly "EXPLANATION:" on a new line then 2-3 plain English sentences explaining the key decisions and any caveats.`;

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
      return res.status(response.status).json({
        error: error.error?.message || 'API error ' + response.status
      });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    console.error('Function error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
