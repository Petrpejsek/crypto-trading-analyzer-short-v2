import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const schema = { type: "object", properties: { ping: { type: "string" } }, required: ["ping"], additionalProperties: false };
const t0 = Date.now();
try {
  const r = await client.chat.completions.create({
    model: "gpt-5",
    messages: [
      { role: "system", content: "Reply with JSON only." },
      { role: "user", content: JSON.stringify({ ping: "health" }) }
    ],
    response_format: { type: "json_schema", json_schema: { name: "health", schema, strict: true } },
    max_completion_tokens: 16
  }, { timeout: 8000 });
  const text = r?.choices?.[0]?.message?.content || "";
  console.log(JSON.stringify({ ok: true, model: "gpt-5", ms: Date.now()-t0, sample: String(text).slice(0,100) }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, status: e?.status ?? null, message: (e?.response && e.response?.data?.error?.message) ? e.response.data.error.message : (e?.message ?? String(e)) }));
  process.exit(1);
}
