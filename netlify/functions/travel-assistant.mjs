const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.5-flash-lite";

// Netlifyの標準タイムアウト(約10秒)より短く、1回あたり8秒で打ち切る
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
// Netlifyのリクエスト上限(約6MB)に余裕を持たせる
const MAX_IMAGE_BASE64_LENGTH = 4000000;

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// タイムアウト付きfetch
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return response(405, { ok: false, error: "POST method only" });
  }
  if (!GEMINI_API_KEY) {
    return response(500, { ok: false, error: "Gemini API key is not configured." });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const country = body.country || "旅行先";
    const city = body.city || "";
    const mode = body.mode || "chat";

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return response(400, { ok: false, error: "メッセージがありません。" });
    }

    const messages = body.messages.slice(-20);
    const image = body.image;

    const contents = messages.map((message, index) => {
      const role =
        message.role === "model" || message.role === "assistant" ? "model" : "user";
      const parts = [{ text: String(message.content || "") }];

      if (
        index === messages.length - 1 &&
        role === "user" &&
        image &&
        typeof image.data === "string"
      ) {
        const mimeType = ["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)
          ? image.mimeType
          : "image/jpeg";
        const base64 = image.data.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");

        if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
          const err = new Error("画像サイズが大きすぎます。小さくしてから送ってください。");
          err.statusCode = 413;
          throw err;
        }
        parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
      }
      return { role, parts };
    });

    const systemInstruction = `
あなたはTABISWITCH AIという日本人旅行者向けの旅行サポートAIです。

旅行先：${country} ${city}
利用モード：${mode}

以下の方針を守ってください。

・日本語で分かりやすく回答する
・旅行者の不安を解消する
・現地の文化、マナー、交通、観光、食事について案内する
・初心者にも分かるよう具体的に説明する
・必要に応じて箇条書きで整理する
・料金や営業時間など、変動する情報は断定しない
・確認できていない情報は、未確認であると伝える
・緊急時は現地の公的機関や緊急連絡先への連絡を優先する
・写真が送られた場合は、写っている文字を読み取り日本語に翻訳する
・写真の内容が不鮮明な場合は、その旨を伝える
・危険な行動や違法行為は勧めない

旅行中のユーザーに寄り添い、実用的な回答をしてください。
`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const requestBody = JSON.stringify({
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: {
        maxOutputTokens: 2048,
        // 考える時間を短くして、速く・空回答になりにくくする
        // ※このモデルで未対応エラーが出る場合は、この行を削除してください
        thinkingConfig: { thinkingLevel: "low" },
      },
    });

    let lastError = "Gemini APIとの通信に失敗しました。";
    let lastStatus = 502;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(500 * attempt);

      let result;
      try {
        result = await fetchWithTimeout(
          url,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody },
          REQUEST_TIMEOUT_MS
        );
      } catch (e) {
        lastError = e.name === "AbortError" ? "AIの応答に時間がかかりすぎました。" : e.message;
        lastStatus = 504;
        console.error(`[attempt ${attempt}] fetch error:`, lastError);
        // タイムアウトはリトライすると合計10秒を超えるので打ち切る
        if (e.name === "AbortError") break;
        continue;
      }

      const data = await result.json().catch(() => ({}));

      if (!result.ok) {
        lastError = data.error?.message || lastError;
        lastStatus = result.status;
        console.error(`[attempt ${attempt}] Gemini ${result.status}:`, lastError);
        // 混雑・一時エラーだけリトライ
        if ([429, 500, 503].includes(result.status)) continue;
        break;
      }

      const candidate = data.candidates?.[0];
      const reply =
        candidate?.content?.parts?.map((p) => p.text || "").join("") || "";

      if (reply) {
        return response(200, { ok: true, reply, model: MODEL });
      }

      // 空回答の理由をログに残す(SAFETY / MAX_TOKENS など)
      const reason = candidate?.finishReason || data.promptFeedback?.blockReason || "UNKNOWN";
      console.error(`[attempt ${attempt}] empty reply. reason:`, reason);
      lastError =
        reason === "SAFETY" || reason === "PROHIBITED_CONTENT"
          ? "この内容にはお答えできませんでした。言い方を変えてお試しください。"
          : "AIから回答を取得できませんでした。もう一度お試しください。";
      lastStatus = 502;
      if (reason === "SAFETY") break;
    }

    return response(lastStatus, { ok: false, error: lastError });
  } catch (error) {
    return response(error.statusCode || 500, {
      ok: false,
      error: error.message || "サーバーエラーが発生しました。",
    });
  }
}
