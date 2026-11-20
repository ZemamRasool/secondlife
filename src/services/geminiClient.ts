// Google Gemini — the one AI provider these services use.
// Structured answers come back through Gemini's responseSchema, and every answer
// is still checked with zod before anything is saved or shown to anyone.

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 90_000;

/**
 * Gemini 2.5 and 3.x think before they write, and the thinking is paid for out of
 * `maxOutputTokens` — so a 200-token budget can be spent entirely on reasoning and
 * leave the answer cut off mid-sentence. Callers ask for the length of the answer
 * they want; this is reserved on top of it for the thinking.
 */
const THINKING_HEADROOM = 2048;

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
export type GeminiTextResult = { ok: true; text: string } | { ok: false; error: string; retryable: boolean };
export type GeminiJsonResult = { ok: true; value: unknown } | { ok: false; error: string; retryable: boolean };

/**
 * Gemini takes a subset of JSON Schema: type names are upper case, there is no
 * additionalProperties, and a nullable field is `nullable: true` rather than
 * `type: ["string", "null"]`. Converting here keeps one schema in the codebase.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties" || key === "$schema") continue;
    if (key === "type" && typeof value === "string") { out.type = value.toUpperCase(); continue; }
    if (key === "type" && Array.isArray(value)) {
      const real = value.filter((t) => t !== "null");
      out.type = String(real[0] ?? "string").toUpperCase();
      if (real.length !== value.length) out.nullable = true;
      continue;
    }
    out[key] = toGeminiSchema(value);
  }
  return out;
}

async function call(apiKey: string, model: string, body: unknown): Promise<GeminiTextResult> {
  try {
    const url = `${BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // 429 and 5xx are temporary: the job queue tries again later.
      return { ok: false, retryable: res.status === 429 || res.status >= 500, error: `Gemini ${res.status}: ${detail.slice(0, 300)}` };
    }
    const data = (await res.json()) as {
      candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
    };
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    // A half-written answer is worse than none: truncated JSON fails to parse, but a
    // truncated question or letter still looks valid. Never hand one back.
    if (candidate?.finishReason === "MAX_TOKENS") {
      return { ok: false, retryable: true, error: "Gemini ran out of output budget before finishing its answer." };
    }
    if (!text) return { ok: false, retryable: true, error: "Gemini returned an empty answer." };
    return { ok: true, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, retryable: true, error: `Gemini request failed: ${message.slice(0, 300)}` };
  }
}

/** Ask for plain text. */
export function geminiText(opts: {
  apiKey: string; model: string; system: string; parts: GeminiPart[]; maxTokens: number;
}): Promise<GeminiTextResult> {
  return call(opts.apiKey, opts.model, {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: "user", parts: opts.parts }],
    generationConfig: { temperature: 0, maxOutputTokens: opts.maxTokens + THINKING_HEADROOM },
  });
}

/** Ask for JSON shaped like `schema`. The caller still validates what comes back. */
export async function geminiJson(opts: {
  apiKey: string; model: string; system: string; parts: GeminiPart[]; schema: unknown; maxTokens: number;
}): Promise<GeminiJsonResult> {
  const res = await call(opts.apiKey, opts.model, {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: "user", parts: opts.parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: opts.maxTokens + THINKING_HEADROOM,
      responseMimeType: "application/json",
      responseSchema: toGeminiSchema(opts.schema),
    },
  });
  if (!res.ok) return res;
  try {
    return { ok: true, value: JSON.parse(res.text) as unknown };
  } catch {
    return { ok: false, retryable: false, error: "Gemini did not return valid JSON." };
  }
}
