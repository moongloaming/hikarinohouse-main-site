// HIKARINOHOUSE 賣場後端 (Cloudflare Worker + Static Assets)
// 路由：/store/api/* 走動態 API（接 Ragic）；其餘交給靜態資產（官網原本的頁面）。
// Ragic 為資料來源：商品讀自「日本商品」(上架賣場=✓)，訂單寫回「代購訂單」。
//
// 機密由環境變數提供（部署時在 Cloudflare 設為 Secret，程式不寫死）：
//   RAGIC_API_KEY  — Ragic 個人 API Key
// 既有設定（wrangler.toml vars，可公開）：
//   RAGIC_BASE     — 例 https://ap10.ragic.com
//   RAGIC_ACCOUNT  — 例 HIKARINOHOUSE

const RAGIC_BASE_DEFAULT = "https://ap10.ragic.com";
const RAGIC_ACCOUNT_DEFAULT = "HIKARINOHOUSE";

// 日本商品表 forms4/6。欄位以 Ragic 內部欄位 ID 對應。
// 已知：上架賣場 = 1002960。其餘 ID 待有 API Key 後用 ?api 實測填入（見 README 註記）。
const PRODUCT_SHEET = "forms4/6";
// 日本商品欄位 ID（自 Ragic 設計畫面實讀）
const FIELD = {
  商品條碼: "1000272",
  商品名稱: "1000273",
  單價: "1000275",
  中文: "1000452",
  上傳圖片: "1002934",
  上架賣場: "1002960",
  商品分類: "1002961",
};

// 代購訂單表 forms13/26（欄位 ID 自 Ragic 設計畫面實讀）
const ORDER_SHEET = "forms13/26";
const ORDER_FIELD = {
  LINE_UserId: "1002963",
  收件人: "1002964",
  訂單明細: "1002965",
  訂單狀態: "1002966",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function ragicHeaders(env) {
  // Ragic API 以 API Key 作 Basic 認證
  return { Authorization: "Basic " + (env.RAGIC_API_KEY || "") };
}

function ragicUrl(env, sheet, query) {
  const base = env.RAGIC_BASE || RAGIC_BASE_DEFAULT;
  const account = env.RAGIC_ACCOUNT || RAGIC_ACCOUNT_DEFAULT;
  return `${base}/${account}/${sheet}?${query}`;
}

// GET /store/api/products — 回傳上架商品
async function getProducts(env) {
  if (!env.RAGIC_API_KEY) {
    return json({ error: "RAGIC_API_KEY 未設定", products: [] }, 200);
  }
  const url = ragicUrl(
    env,
    PRODUCT_SHEET,
    `api&v=3&where=${FIELD.上架賣場},eq,Yes`
  );
  const resp = await fetch(url, { headers: ragicHeaders(env) });
  if (!resp.ok) return json({ error: "Ragic 讀取失敗", products: [] }, 502);
  const raw = await resp.json();
  // Ragic 回傳物件：{ recordId: { fieldId: value, ... }, ... }
  const products = Object.keys(raw).map((rid) => {
    const r = raw[rid];
    return {
      id: r[FIELD.商品條碼] || rid,
      zh: r[FIELD.中文] || "",
      ja: r[FIELD.商品名稱] || r._name || "",
      price: Number(String(r[FIELD.單價] || "0").replace(/[^0-9.]/g, "")) || 0,
      cat: r[FIELD.商品分類] || "其他",
      img: r[FIELD.上傳圖片] || "",
    };
  });
  return json({ products });
}

// POST /store/api/order — 建立代購訂單
async function createOrder(env, request) {
  if (!env.RAGIC_API_KEY) return json({ error: "RAGIC_API_KEY 未設定" }, 200);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: "訂單沒有商品" }, 400);

  // 訂單明細整理成易讀文字（一行一品項）+ 原始 JSON，存進「訂單明細」欄
  const detailText = items
    .map((it) => `${it.zh || it.id} x${it.qty}`)
    .join("\n");
  const form = new URLSearchParams();
  form.set(ORDER_FIELD.LINE_UserId, body.lineUserId || "");
  form.set(ORDER_FIELD.收件人, body.recipient || "");
  form.set(ORDER_FIELD.訂單明細, detailText + "\n---\n" + JSON.stringify(items));
  form.set(ORDER_FIELD.訂單狀態, "已送出");
  const url = ragicUrl(env, ORDER_SHEET, "api&v=3");
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!resp.ok) return json({ error: "訂單寫入失敗" }, 502);
  const created = await resp.json().catch(() => ({}));
  return json({ ok: true, ragic: created._ragicId || created.ragicId || null });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === "/store/api/products" && request.method === "GET") {
      return getProducts(env);
    }
    if (p === "/store/api/order" && request.method === "POST") {
      return createOrder(env, request);
    }
    // 其餘一律交給靜態資產（官網原頁面 + /store.html）
    return env.ASSETS.fetch(request);
  },
};
