// TABISWITCH AI - Gemini API 中継関数（Netlify Functions）
// APIキーは Netlify の環境変数 GEMINI_API_KEY にだけ保存してください。
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// GEMINI_MODEL が未設定、または利用できない場合に順番に試すモデル。
// Google は新規プロジェクトに 3.5 Flash-Lite / 3.8 Flash を推奨しています（2026年11月時点）。
const FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"];

const SYSTEM_INSTRUCTIONS = `
あなたはTABISWITCH AIという日本人旅行者向けの旅行中アシスタントです。
日本語で、簡潔で具体的に回答してください。必要なら現地語の文例も併記してください。
対象は主にタイ・バンコク、韓国・ソウルです。

重要な安全・正確性ルール:
- 現在の運行状況、営業時間、運賃、空席、緊急連絡先を確認していない場合、断定しない。
- 不明な情報は「公式情報で確認してください」と明示する。数字・電話番号・店舗情報を創作しない。
- 緊急時は現地の緊急サービスや日本大使館・領事館など公的窓口への連絡を優先する。
- 医療・法律・安全に関わる内容は一般情報にとどめ、専門機関への相談を促す。
- 写真の文字が読めない場合は推測せず、読めた部分と不明部分を分ける。
- ユーザーの現在地を自動で知っているふりをしない。ユーザーが送った情報だけを使う。
- 地図や経路はGoogle Maps、韓国ではNaver Map/KakaoMapなどの外部サービスで確認するよう案内する。
- リンクは実在が確かな公式サイトか、地図検索URL（https://www.google.com/maps/search/?api=1&query=検索語）だけを使う。
`;

const MODE_INSTRUCTIONS = {
  general: `回答は次の見出し順を基本にしてください: 「結論」「具体的な行動」（番号付き）「注意事項」「地図・公式サイト」。
初心者にもわかる平易な日本語で、長すぎないように。現地の人に見せる文が役立つ場合は、現地語・読み方（カタカナ）・英語を添えてください。`,
  "photo-translation": `写真翻訳モードです。画像内の文字を読み取り、日本語に翻訳してください。
料理の場合は料理名・材料・味の特徴を説明してください。価格が読み取れる場合は価格も表示してください。
読めない文字は推測せず「不明」と明示してください。項目ごとに見出しや箇条書きで整理してください。`,
  translation: `翻訳モードです。ユーザーが指定した出力形式だけを守り、余計な前置きや説明は書かないでください。`,
  emergency: `緊急サポートモードです。まず身の安全の確保を促し、最初に取るべき行動を番号付きで短く示してください。
電話番号は確実なもの以外は書かず、公式サイトでの確認を促してください。`,
  spots: `観光スポット相談モードです。店舗名・評価・営業時間・価格を創作しないでください。
具体名を挙げる場合は、地図アプリで最新情報と営業状況を確認するよう必ず添えてください。探し方や検索キーワードの提案を重視してください。`,
  transport: `交通案内モードです。運賃・時刻・終電・運行状況は断定せず、公式サイトや地図アプリで確認するよう案内してください。`
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

function generationConfigFor(model) {
  // 2.5 Flash は思考トークンが出力上限を消費して回答が空になることがあるため、思考をオフにする
  if (/^gemini-2\.5-flash/.test(model)) {
    return { temperature: 0.4, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } };
  }
  // 3.x 系は温度の既定値（1.0）のまま使うことが推奨されている
  return { maxOutputTokens: 4096 };
}

function isModelUnavailable(status, message) {
  if (status === 404) return true;
  if (status === 400 || status === 403) {
    return /not found|not supported|is not available|no longer available|deprecated|access to the model|permission/i.test(message || "");
  }
  return false;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POSTで送信してください。" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json(500, { ok: false, error: "サーバーにGEMINI_API_KEYが設定されていません。Netlifyの環境変数を確認してください。" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "送信データを読み取れませんでした。" });
  }

  const country = String(body.country || "未指定").slice(0, 40);
  const city = String(body.city || "未指定").slice(0, 60);
  const mode = MODE_INSTRUCTIONS[body.mode] ? body.mode : "general";
  let messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const image = body.image && typeof body.image.data === "string" ? body.image : null;

  // 会話は user から始める必要があるため、先頭の model 発言は落とす
  messages = messages.filter(m => m && ["user", "model"].includes(m.role) && typeof m.content === "string" && m.content.trim());
  while (messages.length && messages[0].role !== "user") messages.shift();

  // 画像は「最新のユーザー発言」に添付する
  let lastUserIndex = -1;
  messages.forEach((m, i) => { if (m.role === "user") lastUserIndex = i; });

  let imagePart = null;
  if (image) {
    const mimeType = ["image/jpeg", "image/png", "image/webp"].includes(image.mimeType) ? image.mimeType : "image/jpeg";
    const data = image.data.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
    if (data.length > 7_000_000) {
      return json(413, { ok: false, error: "画像が大きすぎます。別の写真を選ぶか、撮り直してください。" });
    }
    imagePart = { inline_data: { mime_type: mimeType, data } };
  }

  const contents = messages.map((m, i) => {
    const parts = [{ text: m.content.slice(0, 12000) }];
    if (imagePart && i === lastUserIndex) parts.push(imagePart);
    return { role: m.role, parts };
  });

  if (!contents.length) return json(400, { ok: false, error: "質問を入力してください。" });

  const preferred = (process.env.GEMINI_MODEL || "").trim();
  const models = [...new Set([preferred, ...FALLBACK_MODELS].filter(Boolean))];

  let lastError = "AIとの通信に失敗しました。";
  for (const model of models) {
    const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const requestBody = {
      system_instruction: {
        parts: [{ text: `${SYSTEM_INSTRUCTIONS}\n${MODE_INSTRUCTIONS[mode]}\n現在の選択地域: ${country} / ${city}\n利用機能: ${mode}` }]
      },
      contents,
      generationConfig: generationConfigFor(model)
    };

    let response, result;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      result = await response.json().catch(() => ({}));
    } catch {
      return json(502, { ok: false, error: "通信エラーが発生しました。ネットワークを確認してください。" });
    }

    if (!response.ok) {
      const message = result?.error?.message || `Gemini API error (${response.status})`;
      if (isModelUnavailable(response.status, message)) {
        lastError = `モデル ${model} は利用できませんでした: ${message}`;
        continue; // 次のモデルを試す
      }
      if (response.status === 429) {
        return json(429, { ok: false, error: "無料利用枠の上限に達した可能性があります。時間をおいて再度お試しください。" });
      }
      if (response.status === 400 && /api key/i.test(message)) {
        return json(500, { ok: false, error: "APIキーが無効です。NetlifyのGEMINI_API_KEYを確認してください。" });
      }
      return json(502, { ok: false, error: `AIとの通信に失敗しました: ${message}` });
    }

    const candidate = result?.candidates?.[0];
    const reply = (candidate?.content?.parts || [])
      .filter(p => !p.thought)
      .map(p => p.text || "")
      .join("\n")
      .trim();

    if (!reply) {
      const blocked = result?.promptFeedback?.blockReason || (candidate?.finishReason === "SAFETY" ? "SAFETY" : "");
      return json(502, {
        ok: false,
        error: blocked
          ? "AIがこの内容への回答を控えました。表現を変えて質問してください。"
          : "AIから回答を取得できませんでした。もう一度お試しください。"
      });
    }
    return json(200, { ok: true, reply, model });
  }

  return json(502, { ok: false, error: `${lastError} Netlifyの環境変数 GEMINI_MODEL に利用可能なモデル名を設定してください。` });
}
