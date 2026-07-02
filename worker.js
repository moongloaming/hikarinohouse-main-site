// HIKARINOHOUSE 賣場後端 (Cloudflare Worker + Static Assets)
// 路由：/store/api/* 走動態 API（接 Ragic）；其餘交給靜態資產（官網原本的頁面）。
// Ragic 為資料來源：商品讀自「賣場商品」(上架=✓)，訂單寫回「代購訂單」；圖片經 worker 代理。
//
// 機密由環境變數提供（部署時在 Cloudflare 設為 Secret，程式不寫死）：
//   RAGIC_API_KEY  — Ragic 個人 API Key
// 既有設定（wrangler.toml vars，可公開）：
//   RAGIC_BASE     — 例 https://ap10.ragic.com
//   RAGIC_ACCOUNT  — 例 HIKARINOHOUSE

const RAGIC_BASE_DEFAULT = "https://ap10.ragic.com";
const RAGIC_ACCOUNT_DEFAULT = "HIKARINOHOUSE";

// 賣場商品表 store/3（「賣場」頁籤；獨立於 127k 筆的日本商品，只放已挑選上架的商品，避免主表變慢）。
// 讀取時 Ragic 以「欄位名稱」為 key 回傳；篩選用「欄位 ID」。
const PRODUCT_SHEET = "store/3";
// 賣場商品欄位 ID（自 Ragic 設計畫面實讀；篩選/寫入用得到）
const FIELD = {
  商品狀態: "1002993", // 從選單選擇：草稿/上架/缺貨/預購/下架
  代購費率: "1002991", // 數值，選填；有填即為此商品指定費率（覆蓋會員/全站）
  庫存: "1002992",     // 數值
};
// 前台會顯示的狀態（草稿/下架/空白 → 不顯示）
const VISIBLE_STATUS = ["上架", "缺貨", "預購"];

// 系統設定表 store/4（全站參數；目前放代購費率，未來可擴充其它設定）
// 欄位：設定項目(1002986, 自由輸入) / 全站代購費率(1002985, 數值)
const SETTINGS_SHEET = "store/4";
const DEFAULT_FEE_RATE = 0.1; // 讀不到設定時的後備值

// 商品分類主檔 store/2（賣場頁籤）。欄位：分類名稱(1002988) / 排序(1002989)
const CATEGORY_SHEET = "store/2";

// 客戶名單 forms8/26（line_gas_fix 綁定寫入的主檔；賣場「只讀」共用同一套綁定）
// 欄位 ID 取自 line_gas_fix/13_Config.js：LINE User ID=1002909
const CUSTOMER_SHEET = "forms8/26";
const CUSTOMER_FIELD_LINE_UID = "1002909";
// 會員設定表 member/1（等級→代購費率 1002994）
const MEMBER_SHEET = "member/1";

// 代購訂單表 store/5（「賣場」頁籤；欄位 ID 自 Ragic 設計畫面實讀）
const ORDER_SHEET = "store/5";
const ORDER_FIELD = {
  LINE_UserId: "1002963",
  訂單狀態: "1002966",
  客戶編號: "1002996", // 連結客戶名單（LINE 登入接上後帶入）
  收件人: "1002964",   // 表單顯示為「客戶名稱」；下單直接寫客戶姓名
  會員等級: "1002998", // 連結載入不會經 API 觸發，故下單直接寫入
  訂單金額: "1003001", // = Σ小計（商品到手總額）
  運費: "1002999",     // 由檢品運費帶回
  重量: "1002997",     // 由檢品合計重量帶回
  付款金額: "1003000", // = 檢品合計金額（帶回，台幣）
  匯率: "1003010",     // JPY→TWD 匯率快照（下單當下寫入，之後不變）
};

// 匯率來源（雙保險）：
// 1) Ragic 賣場「匯率」表 store/6 —— line_gas_fix 每日 06 時從 Google Sheet 同步進來（營運可見、可人工補列）
// 2) 備援：直讀 sales_ledger 每日更新的台銀 JPY 現金賣出匯率 CSV
const RATE_SHEET = "store/6";
const RATE_FIELD = { 日期: "1003011", 幣別: "1003012", 現金賣出匯率: "1003013" };
const RATE_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1b_MeMAZwehA7OUa6dfBLMGkEoXBHi9tJ-VmVe-sAJT8/export?format=csv&gid=412630458";
// 讀訂單時，明細子表格在單筆記錄回傳的 key（forms API 單筆讀）
const ORDER_SUBTABLE_KEY = "_subtable_1003009";

// 檢品表 forms8/8（⚠️ 線上生產表；結單時轉拋建立記錄）。欄位 ID 自檢品設計唯讀取得
const INSPECT_SHEET = "forms8/8";
const INSPECT_FIELD = {
  客戶編號: "1000397", // 連結客戶名單
  結單編號: "1001532", // 存賣場訂單編號,讓檢品對回訂單
  收件人: "1000371",
  電話: "1001594",
  地址: "1001595",
  訂單金額: "1001534",
  // 以下為「檢品當下才填」的必填欄，結單建草稿時先給佔位值，檢品人員再補
  負責人: "1001559",
  長: "1000367",
  寬: "1000370",
  高: "1000373",
  合計重量: "1000455",
  運費: "1001417",
  檢品完成: "1001426",
};
const INSPECT_SUB = {
  商品條碼: "1000560", // 連結日本商品 → 自動帶 原產國/單價
  數量: "1000330",
  商品名稱: "1000341",
  原產國: "1000342",
  單價: "1000343",
  小計: "1000344",
};
// 日本商品主表 forms4/6：商品條碼欄 1000272，用來查原產國
const JP_PRODUCT_SHEET = "forms4/6";
const JP_FIELD_BARCODE = "1000272";

// 訂單明細「子表格」欄位 ID。Ragic 子表格新列寫法：欄位ID_-<n>（負數列索引）
const ORDER_SUB = {
  商品條碼: "1003002",
  日文名稱: "1003003",
  中文名稱: "1003004",
  單價: "1003005", // 日本原價（每單位）
  代購費: "1003006", // 每單位代購費 = 到手單價 − 原價
  數量: "1003007",
  小計: "1003008", // = 到手單價 × 數量
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function ragicHeaders(env) {
  // Ragic API 以 API Key 作 Basic 認證;需帶 User-Agent，否則 Ragic 會回 403 Blocked
  return {
    Authorization: "Basic " + (env.RAGIC_API_KEY || ""),
    "User-Agent": "Mozilla/5.0 (hikarinohouse-store)",
  };
}

function ragicUrl(env, sheet, query) {
  const base = env.RAGIC_BASE || RAGIC_BASE_DEFAULT;
  const account = env.RAGIC_ACCOUNT || RAGIC_ACCOUNT_DEFAULT;
  const key = encodeURIComponent(env.RAGIC_API_KEY || "");
  return `${base}/${account}/${sheet}?${query}&APIKey=${key}`;
}

// GET /store/api/products — 回傳前台可見商品（商品狀態 ∈ 上架/缺貨/預購）
async function getProducts(env) {
  if (!env.RAGIC_API_KEY) {
    return json({ error: "RAGIC_API_KEY 未設定", products: [] }, 200);
  }
  // 目前商品數少，先全撈再於 JS 過濾狀態（Ragic where 不易做「多值 OR」）；
  // 規模化後改為伺服器端分頁 + 狀態索引。
  const url = ragicUrl(env, PRODUCT_SHEET, "api&v=3");
  const resp = await fetch(url, { headers: ragicHeaders(env) });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    return json({ error: "Ragic 讀取失敗", status: resp.status, detail: t.slice(0, 200), products: [] }, 502);
  }
  const raw = await resp.json();
  // Ragic 回傳物件：{ recordId: { 欄位名稱: value, ... }, ... }（欄位以「名稱」為 key）
  const num = (v) => {
    const s = String(v == null ? "" : v).replace(/[^0-9.]/g, "");
    return s === "" ? null : Number(s);
  };
  const products = Object.keys(raw)
    .filter((k) => raw[k] && typeof raw[k] === "object" && raw[k]._ragicId !== undefined)
    .map((rid) => {
      const r = raw[rid];
      const fileVal = r["圖片"] || "";
      return {
        id: r["商品條碼"] || rid,
        zh: r["中文名"] || "",
        ja: r["產品名稱"] || "",
        price: num(r["單價"]) || 0,
        cat: r["種類"] || "其他",
        desc: r["敘述"] || "",
        status: r["商品狀態"] || "",
        feeRate: num(r["代購費率"]), // 商品指定費率（含 0）；null=未指定
        stock: num(r["庫存"]),
        // 圖片走 worker 代理（Ragic 私有檔案需帶 API Key，不能讓瀏覽器直連）
        img: fileVal ? `/store/api/img?f=${encodeURIComponent(fileVal)}` : "",
      };
    })
    .filter((p) => VISIBLE_STATUS.includes(p.status));
  const [feeRate, categories, jpyRate] = await Promise.all([getFeeRate(env), getCategories(env), getJpyRate(env)]);
  return json({ products, feeRate, categories, jpyRate });
}

// 讀 JPY→TWD 匯率：Ragic 優先、CSV 備援；取日期最新的 JPY 列。
// 讀不到回 null（前端不顯示台幣參考價、下單不寫匯率快照——不擋交易）。
async function getJpyRate(env) {
  const fromRagic = await getJpyRateFromRagic(env);
  if (fromRagic) return fromRagic;
  return getJpyRateFromCsv();
}

async function getJpyRateFromRagic(env) {
  try {
    if (!env || !env.RAGIC_API_KEY) return null;
    const q = `api&v=3&where=${RATE_FIELD.幣別},eq,JPY&limit=500`;
    const resp = await fetch(ragicUrl(env, RATE_SHEET, q), { headers: ragicHeaders(env), cf: { cacheTtl: 900 } });
    if (!resp.ok) return null;
    const raw = await resp.json();
    let best = null;
    for (const r of Object.values(raw)) {
      if (!r || typeof r !== "object" || r._ragicId === undefined) continue;
      const rate = Number(String(r["現金賣出匯率"] || "").replace(/[^0-9.]/g, ""));
      const date = String(r["日期"] || "").trim();
      if (!(rate > 0)) continue;
      if (!best || date > best.date) best = { date, rate };
    }
    return best ? best.rate : null;
  } catch {
    return null;
  }
}

async function getJpyRateFromCsv() {
  try {
    const resp = await fetch(RATE_CSV_URL, { redirect: "follow", cf: { cacheTtl: 1800, cacheEverything: true } });
    if (!resp.ok) return null;
    const text = await resp.text();
    let best = null;
    for (const line of text.trim().split(/\r?\n/).slice(1)) {
      const cols = line.split(",");
      if ((cols[1] || "").trim() !== "JPY") continue;
      const rate = Number((cols[2] || "").trim());
      const date = (cols[0] || "").trim();
      if (!rate || rate <= 0) continue;
      if (!best || date > best.date) best = { date, rate };
    }
    return best ? best.rate : null;
  } catch {
    return null;
  }
}

// 讀商品分類主檔（依排序）；讀不到就回空陣列（前端會用內建後備）
async function getCategories(env) {
  try {
    const url = ragicUrl(env, CATEGORY_SHEET, "api&v=3");
    const resp = await fetch(url, { headers: ragicHeaders(env) });
    if (!resp.ok) return [];
    const raw = await resp.json();
    return Object.keys(raw)
      .filter((k) => raw[k] && typeof raw[k] === "object" && raw[k]._ragicId !== undefined && raw[k]["分類名稱"])
      .map((k) => ({ name: raw[k]["分類名稱"], sort: Number(raw[k]["排序"]) || 999 }))
      .sort((a, b) => a.sort - b.sort)
      .map((c) => c.name);
  } catch (e) {
    return [];
  }
}

// 讀全站代購費率（系統設定表）；讀不到就回後備值
async function getFeeRate(env) {
  try {
    const url = ragicUrl(env, SETTINGS_SHEET, "api&v=3");
    const resp = await fetch(url, { headers: ragicHeaders(env) });
    if (!resp.ok) return DEFAULT_FEE_RATE;
    const raw = await resp.json();
    for (const k of Object.keys(raw)) {
      const r = raw[k];
      if (r && typeof r === "object" && r._ragicId !== undefined && r["全站代購費率"]) {
        const v = Number(String(r["全站代購費率"]).replace(/[^0-9.]/g, ""));
        if (v > 0 && v < 1) return v;
      }
    }
  } catch (e) {
    /* 靜默降級為後備值 */
  }
  return DEFAULT_FEE_RATE;
}

// 用 LINE userId 查客戶名單（共用 line_gas_fix 綁定）；回 null 表示未綁定/查無
async function getCustomer(env, uid) {
  if (!uid) return null;
  try {
    const url = ragicUrl(env, CUSTOMER_SHEET, `api&v=3&where=${CUSTOMER_FIELD_LINE_UID},eq,${encodeURIComponent(uid)}`);
    const resp = await fetch(url, { headers: ragicHeaders(env) });
    if (!resp.ok) return null;
    const raw = await resp.json();
    const r = Object.values(raw).find((v) => v && typeof v === "object" && v._ragicId !== undefined);
    if (!r) return null;
    return {
      code: r["客戶編號"] || "",
      name: r["姓名"] || "",
      tier: r["目前會員等級"] || "",
      freightUnit: r["目前運費單價"] || "",
      phone: r["電話"] || "",
      address: r["地址"] || "",
    };
  } catch (e) {
    return null;
  }
}

// 查某會員等級的代購費率（會員設定表）；沒設就回 null（→ 往下用全站）
async function getTierFeeRate(env, tierName) {
  if (!tierName) return null;
  try {
    const url = ragicUrl(env, MEMBER_SHEET, "api&v=3");
    const resp = await fetch(url, { headers: ragicHeaders(env) });
    if (!resp.ok) return null;
    const raw = await resp.json();
    for (const k of Object.keys(raw)) {
      const r = raw[k];
      if (r && r["會員等級"] === tierName && r["代購費率"] !== "" && r["代購費率"] != null) {
        const v = Number(String(r["代購費率"]).replace(/[^0-9.]/g, ""));
        if (v >= 0 && v < 1) return v;
      }
    }
  } catch (e) {
    /* fall through */
  }
  return null;
}

// 用商品條碼去日本商品主表查原產國（每個商品可能不同：Japan/China…）
async function getOrigin(env, barcode) {
  if (!barcode) return "";
  try {
    const url = ragicUrl(env, JP_PRODUCT_SHEET, `api&v=3&where=${JP_FIELD_BARCODE},eq,${encodeURIComponent(barcode)}`);
    const resp = await fetch(url, { headers: ragicHeaders(env) });
    if (!resp.ok) return "";
    const raw = await resp.json();
    const r = Object.values(raw).find((v) => v && typeof v === "object" && v._ragicId !== undefined);
    return r ? r["原產國"] || "" : "";
  } catch (e) {
    return "";
  }
}

// 讀賣場商品，回傳以商品條碼為 key 的對照表（下單時用伺服器端真值做快照，不信任前端價格）
async function getProductMap(env) {
  const map = {};
  try {
    const url = ragicUrl(env, PRODUCT_SHEET, "api&v=3");
    const resp = await fetch(url, { headers: ragicHeaders(env) });
    if (!resp.ok) return map;
    const raw = await resp.json();
    const num = (v) => {
      const s = String(v == null ? "" : v).replace(/[^0-9.]/g, "");
      return s === "" ? null : Number(s);
    };
    for (const k of Object.keys(raw)) {
      const r = raw[k];
      if (!r || typeof r !== "object" || r._ragicId === undefined) continue;
      const code = r["商品條碼"];
      if (!code) continue;
      map[code] = {
        price: num(r["單價"]) || 0,
        zh: r["中文名"] || "",
        ja: r["產品名稱"] || "",
        feeRate: num(r["代購費率"]),
        status: r["商品狀態"] || "",
        stock: num(r["庫存"]) || 0,
        rid: r._ragicId,
        img: r["圖片"] ? `/store/api/img?f=${encodeURIComponent(r["圖片"])}` : "",
      };
    }
  } catch (e) {
    /* 回傳目前 map */
  }
  return map;
}

// GET /store/api/img?f=<fileKey@name> — 代理 Ragic 私有圖片（帶 API Key 抓後回傳給瀏覽器）
async function getImage(env, url) {
  const f = url.searchParams.get("f");
  if (!f) return new Response("missing f", { status: 400 });
  if (!env.RAGIC_API_KEY) return new Response("no key", { status: 503 });
  const base = env.RAGIC_BASE || RAGIC_BASE_DEFAULT;
  const account = env.RAGIC_ACCOUNT || RAGIC_ACCOUNT_DEFAULT;
  const fileUrl = `${base}/sims/file.jsp?a=${account}&f=${encodeURIComponent(f)}`;
  const resp = await fetch(fileUrl, { headers: ragicHeaders(env) });
  if (!resp.ok) return new Response("image not found", { status: 404 });
  return new Response(resp.body, {
    status: 200,
    headers: {
      "content-type": resp.headers.get("content-type") || "image/jpeg",
      "cache-control": "public, max-age=86400",
    },
  });
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

  // 以伺服器端真值做快照（不信任前端價格）：查商品表 + 全站費率 + 客戶
  const [prodMap, feeRate, customer, jpyRate] = await Promise.all([
    getProductMap(env),
    getFeeRate(env),
    getCustomer(env, body.lineUserId),
    getJpyRate(env),
  ]);
  // 會員等級費率（找得到客戶才查）；費率決定序：商品指定 > 會員等級 > 全站
  const memberRate = customer ? await getTierFeeRate(env, customer.tier) : null;

  const form = new URLSearchParams();
  form.set(ORDER_FIELD.訂單狀態, "已送出"); // 客戶送出訂單（→配單→已配單→結單…）
  if (body.lineUserId) form.set(ORDER_FIELD.LINE_UserId, body.lineUserId);
  if (customer) {
    if (customer.code) form.set(ORDER_FIELD.客戶編號, customer.code); // 綁到客戶名單
    if (customer.name) form.set(ORDER_FIELD.收件人, customer.name);
    if (customer.tier) form.set(ORDER_FIELD.會員等級, customer.tier);
  }

  let orderTotal = 0;
  let rowIdx = 0;
  for (const it of items) {
    const p = prodMap[it.id];
    if (!p) continue; // 找不到的商品（例如已下架）跳過
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    const price = p.price;
    // 費率決定序：商品指定(含0) > 會員等級 > 全站
    const rate = p.feeRate != null ? p.feeRate : memberRate != null ? memberRate : feeRate;
    const toHand = Math.round(price * (1 + rate)); // 到手單價
    const fee = toHand - price; // 每單位代購費
    const sub = toHand * qty; // 小計＝到手單價×數量
    orderTotal += sub;
    rowIdx += 1;
    const suf = "_-" + rowIdx; // Ragic 子表格新列：負數列索引
    form.set(ORDER_SUB.商品條碼 + suf, it.id);
    form.set(ORDER_SUB.日文名稱 + suf, p.ja || "");
    form.set(ORDER_SUB.中文名稱 + suf, p.zh || "");
    form.set(ORDER_SUB.單價 + suf, String(price));
    form.set(ORDER_SUB.代購費 + suf, String(fee));
    form.set(ORDER_SUB.數量 + suf, String(qty));
    form.set(ORDER_SUB.小計 + suf, String(sub));
  }
  if (!rowIdx) return json({ error: "訂單商品都無法對應（可能已下架）" }, 400);
  form.set(ORDER_FIELD.訂單金額, String(orderTotal)); // 日圓（商品主檔幣別）
  if (jpyRate) form.set(ORDER_FIELD.匯率, String(jpyRate)); // 匯率快照：下單當下的台銀 JPY 賣出價

  const url = ragicUrl(env, ORDER_SHEET, "api&v=3");
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!resp.ok) return json({ error: "訂單寫入失敗" }, 502);
  const created = await resp.json().catch(() => ({}));
  return json({ ok: true, ragic: created.ragicId || null, orderNo: created.data ? created.data["1002962"] : null, total: orderTotal });
}

// POST /store/api/checkout {orderId} — 客戶結單：轉拋建立檢品(帶商品明細) + 訂單狀態→已結單
// ⚠️ 會寫入線上生產檢品表 forms8/8
async function checkout(env, request) {
  if (!env.RAGIC_API_KEY) return json({ error: "RAGIC_API_KEY 未設定" }, 200);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid body" }, 400); }
  const orderId = body.orderId;
  if (orderId == null || orderId === "") return json({ error: "缺 orderId" }, 400);

  // 1. 讀訂單(含明細子表格)
  const oResp = await fetch(ragicUrl(env, `${ORDER_SHEET}/${encodeURIComponent(orderId)}`, "api&v=3"), { headers: ragicHeaders(env) });
  if (!oResp.ok) return json({ error: "讀訂單失敗", status: oResp.status }, 502);
  const oRaw = await oResp.json();
  const order = oRaw[String(orderId)] || Object.values(oRaw)[0];
  if (!order || order._ragicId === undefined) return json({ error: "找不到訂單" }, 404);
  const subObj = order[ORDER_SUBTABLE_KEY] || {};
  const lines = Object.values(subObj).filter((r) => r && r["商品條碼"]);
  if (!lines.length) return json({ error: "訂單沒有明細" }, 400);

  // 查客戶(補收件人/電話/地址；檢品這些為必填、API 連結載入不一定會自動帶)
  const customer = await getCustomer(env, order["LINE_UserId"]);

  // 匯率：優先用訂單快照；舊單沒有就抓當下匯率補上（並回寫訂單）
  let rate = Number(String(order["匯率"] || "").replace(/[^0-9.]/g, "")) || 0;
  let rateFetched = false;
  if (!rate) {
    rate = (await getJpyRate(env)) || 0;
    rateFetched = rate > 0;
  }
  const yenTotal = Number(String(order["訂單金額"] || "0").replace(/[^0-9.]/g, "")) || 0;
  // 檢品「訂單金額」寫台幣（與既有檢品/運費同幣別 → 合計金額=訂單金額+運費 全程台幣）
  const ntTotal = rate > 0 ? Math.round(yenTotal * rate) : yenTotal;

  // 2. 建檢品「草稿」：客戶資料 + 訂單金額(台幣) + 明細；材積/重量/運費等檢品當下才知道的先給佔位值
  const form = new URLSearchParams();
  if (order["客戶編號"]) form.set(INSPECT_FIELD.客戶編號, order["客戶編號"]);
  if (order["訂單編號"]) form.set(INSPECT_FIELD.結單編號, order["訂單編號"]); // 檢品對回訂單
  if (yenTotal) form.set(INSPECT_FIELD.訂單金額, String(ntTotal));
  if (customer) {
    form.set(INSPECT_FIELD.收件人, customer.name);
    form.set(INSPECT_FIELD.電話, customer.phone);
    form.set(INSPECT_FIELD.地址, customer.address);
  }
  // 負責人 + 檢品完成=No(新建草稿未完成)。長/寬/高/重量已非必填,交給檢品人員填
  form.set(INSPECT_FIELD.負責人, "輸出部08");
  form.set(INSPECT_FIELD.檢品完成, "X"); // 檢品完成？欄位值為 Yes/X；新建草稿＝X(未完成)
  let idx = 0;
  for (const ln of lines) {
    const bc = ln["商品條碼"];
    const origin = await getOrigin(env, bc);
    idx += 1;
    const suf = "_-" + idx;
    form.set(INSPECT_SUB.商品條碼 + suf, bc);
    form.set(INSPECT_SUB.數量 + suf, String(ln["數量"] || ""));
    form.set(INSPECT_SUB.商品名稱 + suf, ln["中文名稱"] || ln["日文名稱"] || "");
    form.set(INSPECT_SUB.原產國 + suf, origin);
    form.set(INSPECT_SUB.單價 + suf, String(ln["單價"] || ""));
    form.set(INSPECT_SUB.小計 + suf, String(ln["小計"] || ""));
  }
  // doLinkLoad=first：先跑連結載入(客戶編號→帶地址/等級、商品條碼→帶主表原產國/單價)，再算公式(合計金額/材積等)
  const iResp = await fetch(ragicUrl(env, INSPECT_SHEET, "api&v=3&doLinkLoad=first&doFormula=true"), {
    method: "POST",
    headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const created = await iResp.json().catch(() => ({}));
  if (!iResp.ok || created.status !== "SUCCESS") {
    return json({ error: "建立檢品失敗", httpStatus: iResp.status, detail: created }, 502);
  }

  // 3. 訂單狀態 → 已結單（舊單缺匯率則一併補快照）
  const uForm = new URLSearchParams();
  uForm.set(ORDER_FIELD.訂單狀態, "已結單");
  if (rateFetched) uForm.set(ORDER_FIELD.匯率, String(rate));
  await fetch(ragicUrl(env, `${ORDER_SHEET}/${encodeURIComponent(orderId)}`, "api&v=3"), {
    method: "POST",
    headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
    body: uForm.toString(),
  });

  return json({ ok: true, inspectId: created.ragicId || null, lines: lines.length });
}

// GET /store/api/orders?uid=<lineUserId> — 查此客戶的訂單清單（我的訂單頁用）
async function getMyOrders(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return json({ orders: [] });
  try {
    const listUrl = ragicUrl(env, ORDER_SHEET, `api&v=3&where=${ORDER_FIELD.LINE_UserId},eq,${encodeURIComponent(uid)}`);
    const resp = await fetch(listUrl, { headers: ragicHeaders(env) });
    if (!resp.ok) return json({ orders: [] });
    const raw = await resp.json();
    const orders = Object.values(raw)
      .filter((r) => r && typeof r === "object" && r._ragicId !== undefined)
      .map((r) => ({
        id: r._ragicId,
        no: r["訂單編號"] || "",
        status: r["訂單狀態"] || "",
        code: r["客戶編號"] || "",
        total: Number(String(r["訂單金額"] || "0").replace(/[^0-9.]/g, "")) || 0,
        pay: Number(String(r["付款金額"] || "0").replace(/[^0-9.]/g, "")) || 0,
        freight: Number(String(r["運費"] || "0").replace(/[^0-9.]/g, "")) || 0,
        rate: Number(String(r["匯率"] || "0").replace(/[^0-9.]/g, "")) || 0, // 下單快照
      }))
      .sort((a, b) => b.id - a.id);
    // B5：已結單的單去撈對應檢品運費 → 算付款金額；檢品完成即顯示為待付款
    await Promise.all(
      orders
        .filter((o) => o.status === "已結單" || o.status === "檢品完成" || o.status === "待付款")
        .map(async (o) => {
          const ins = await getInspection(env, o.no);
          if (ins && ins.done) {
            // 檢品合計金額=台幣；後備算法也先把日圓訂單金額換成台幣再加運費
            const ntTotal = o.rate > 0 ? Math.round(o.total * o.rate) : o.total;
            const pay = ins.grand > 0 ? ins.grand : ntTotal + ins.freight; // 以檢品合計金額為準
            const prevPay = o.pay;
            o.freight = ins.freight;
            o.weight = ins.weight;
            o.pay = pay;
            o.status = "待付款"; // 由檢品完成推導
            // 帶回訂單（運費/重量/付款金額）；只在有變動時寫，避免重複寫入
            if (prevPay !== pay) {
              const f = new URLSearchParams();
              f.set(ORDER_FIELD.運費, String(ins.freight));
              f.set(ORDER_FIELD.重量, String(ins.weight));
              f.set(ORDER_FIELD.付款金額, String(pay));
              try {
                await fetch(ragicUrl(env, `${ORDER_SHEET}/${o.id}`, "api&v=3"), {
                  method: "POST",
                  headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
                  body: f.toString(),
                });
              } catch (e) { /* 顯示不受影響 */ }
            }
          }
        })
    );
    return json({ orders });
  } catch (e) {
    return json({ orders: [] });
  }
}

// B5：用「結單編號」(=賣場訂單編號，checkout 時寫入) 去檢品表撈回運費
// 回 {freight, done} 或 null（找不到對應檢品）
async function getInspection(env, orderNo) {
  if (!orderNo) return null;
  try {
    const q = `api&v=3&where=${INSPECT_FIELD.結單編號},eq,${encodeURIComponent(orderNo)}`;
    const resp = await fetch(ragicUrl(env, INSPECT_SHEET, q), { headers: ragicHeaders(env) });
    if (!resp.ok) return null;
    const raw = await resp.json();
    // 取最新一筆對應檢品
    const recs = Object.values(raw).filter((r) => r && typeof r === "object" && r._ragicId !== undefined).sort((a, b) => b._ragicId - a._ragicId);
    if (!recs.length) return null;
    const r = recs[0];
    const num = (v) => Number(String(v || "0").replace(/[^0-9.]/g, "")) || 0;
    return {
      inspectId: r._ragicId,
      freight: num(r["運費"]),
      weight: num(r["合計重量"]),
      grand: num(r["合計金額"]),
      done: String(r["檢品完成？"] || "") === "Yes",
    };
  } catch (e) {
    return null;
  }
}

// GET /store/api/orderitems?id=<ragicId>&uid=<lineUserId> — 點開某筆訂單才載入明細（本人限定）
async function getOrderItems(env, url) {
  const id = url.searchParams.get("id");
  const uid = url.searchParams.get("uid");
  if (!id || !uid) return json({ items: [] });
  try {
    const rr = await fetch(ragicUrl(env, `${ORDER_SHEET}/${encodeURIComponent(id)}`, "api&v=3"), { headers: ragicHeaders(env) });
    const rec = (await rr.json())[String(id)] || {};
    if (rec._ragicId === undefined) return json({ items: [] });
    if (rec["LINE_UserId"] !== uid) return json({ error: "not owner", items: [] }, 403); // 只能看自己的
    const sub = rec[ORDER_SUBTABLE_KEY] || {};
    const items = Object.values(sub)
      .filter((l) => l && l["商品條碼"])
      .map((l) => ({ id: l["商品條碼"], zh: l["中文名稱"] || l["日文名稱"] || "", qty: l["數量"] || "", sub: Number(String(l["小計"] || "0").replace(/[^0-9.]/g, "")) || 0 }));
    return json({ items });
  } catch (e) {
    return json({ items: [] });
  }
}

// GET /store/api/me?uid=<lineUserId> — LIFF 登入後查客戶身分 + 該會員適用費率
async function getMe(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return json({ found: false });
  const customer = await getCustomer(env, uid);
  if (!customer) return json({ found: false }); // 未綁定 → 前端引導回 bot 綁定
  const memberRate = await getTierFeeRate(env, customer.tier);
  const feeRate = memberRate != null ? memberRate : await getFeeRate(env);
  return json({
    found: true,
    name: customer.name,
    tier: customer.tier,
    code: customer.code,
    feeRate, // 該會員的基礎費率（商品若有指定費率仍會覆蓋）
  });
}

// ===== 賣場後台（採購用；通行碼=Cloudflare Secret STORE_ADMIN_TOKEN）=====
const PURCHASE_SHEET = "store/7";
const PURCHASE_FIELD = { 已購數量: "1003020", 狀態: "1003021", 預計採購日: "1003023" };

function adminAuthorized(env, request, url) {
  const t = request.headers.get("x-admin-token") || url.searchParams.get("token") || "";
  return !!env.STORE_ADMIN_TOKEN && t === env.STORE_ADMIN_TOKEN;
}

// GET /store/api/admin/purchases — 採購清單全狀態（前端分組顯示）
async function adminGetPurchases(env, request, url) {
  if (!adminAuthorized(env, request, url)) return json({ error: "unauthorized" }, 401);
  const [resp, prodMap] = await Promise.all([
    fetch(ragicUrl(env, PURCHASE_SHEET, "api&v=3&limit=500"), { headers: ragicHeaders(env) }),
    getProductMap(env),
  ]);
  if (!resp.ok) return json({ error: "Ragic 讀取失敗" }, 502);
  const raw = await resp.json();
  const num = (v) => Number(String(v == null ? "" : v).replace(/[^0-9.]/g, "")) || 0;
  const rows = Object.values(raw)
    .filter((r) => r && typeof r === "object" && r._ragicId !== undefined)
    .map((r) => ({
      img: (prodMap[String(r["商品條碼"] || "").trim()] || {}).img || "",
      id: r._ragicId,
      date: r["日期"] || "",
      barcode: r["商品條碼"] || "",
      name: r["商品名稱"] || "",
      need: num(r["需求數量"]),
      bought: num(r["已購數量"]),
      status: r["狀態"] || "",
      plan: r["預計採購日"] || "", // 空=未排;yyyy/MM/dd=已排
    }))
    .sort((a, b) => b.id - a.id);
  return json({ rows, today: jstToday() });
}

function jstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "/");
}

// POST /store/api/admin/plan {id, plan:true|false} — 排進/移出「今日採購清單」
async function adminPurchasePlan(env, request, url) {
  if (!adminAuthorized(env, request, url)) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid body" }, 400); }
  if (body.id == null) return json({ error: "缺 id" }, 400);
  const f = new URLSearchParams();
  f.set(PURCHASE_FIELD.預計採購日, body.plan ? jstToday() : "");
  const resp = await fetch(ragicUrl(env, `${PURCHASE_SHEET}/${encodeURIComponent(body.id)}`, "api&v=3"), {
    method: "POST",
    headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
    body: f.toString(),
  });
  if (!resp.ok) return json({ error: "寫入失敗" }, 502);
  return json({ ok: true });
}

// POST /store/api/admin/bought {id, bought} — 店裡記「買到N」（只記數量,狀態仍=待採購→畫面歸「待點收」;0=反悔）
async function adminPurchaseBought(env, request, url) {
  if (!adminAuthorized(env, request, url)) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid body" }, 400); }
  if (body.id == null) return json({ error: "缺 id" }, 400);
  const bought = Math.max(0, parseInt(body.bought, 10) || 0);
  const f = new URLSearchParams();
  f.set(PURCHASE_FIELD.已購數量, String(bought));
  const resp = await fetch(ragicUrl(env, `${PURCHASE_SHEET}/${encodeURIComponent(body.id)}`, "api&v=3"), {
    method: "POST",
    headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
    body: f.toString(),
  });
  if (!resp.ok) return json({ error: "寫入失敗" }, 502);
  return json({ ok: true });
}

// POST /store/api/admin/unarrive {id} — 誤按入庫的退回（只允許狀態=已入庫；入庫完成=庫存已入帳,不可退）
async function adminPurchaseUnarrive(env, request, url) {
  if (!adminAuthorized(env, request, url)) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid body" }, 400); }
  if (body.id == null) return json({ error: "缺 id" }, 400);
  const rResp = await fetch(ragicUrl(env, `${PURCHASE_SHEET}/${encodeURIComponent(body.id)}`, "api&v=3"), { headers: ragicHeaders(env) });
  if (!rResp.ok) return json({ error: "讀取失敗" }, 502);
  const rRaw = await rResp.json();
  const rec = rRaw[String(body.id)] || Object.values(rRaw)[0];
  if (!rec) return json({ error: "找不到資料" }, 404);
  if ((rec["狀態"] || "") !== "已入庫") {
    return json({ error: "系統已入帳（入庫完成），不能退回；請聯絡管理者調整庫存" }, 409);
  }
  const f = new URLSearchParams();
  f.set(PURCHASE_FIELD.狀態, "待採購");
  f.set(PURCHASE_FIELD.已購數量, "0");
  f.set(PURCHASE_FIELD.預計採購日, jstToday()); // 退回後留在今日清單
  const resp = await fetch(ragicUrl(env, `${PURCHASE_SHEET}/${encodeURIComponent(body.id)}`, "api&v=3"), {
    method: "POST",
    headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
    body: f.toString(),
  });
  if (!resp.ok) return json({ error: "寫入失敗" }, 502);
  return json({ ok: true });
}

// POST /store/api/admin/arrive {id, bought} — 點收入庫：庫存「立即」入帳＋標入庫完成（配單另由「待配單」人工執行）
async function adminPurchaseArrive(env, request, url) {
  if (!adminAuthorized(env, request, url)) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid body" }, 400); }
  const id = body.id;
  const bought = Math.max(0, parseInt(body.bought, 10) || 0);
  if (id == null || !bought) return json({ error: "缺 id 或 已購數量" }, 400);
  const rResp = await fetch(ragicUrl(env, `${PURCHASE_SHEET}/${encodeURIComponent(id)}`, "api&v=3"), { headers: ragicHeaders(env) });
  if (!rResp.ok) return json({ error: "讀取失敗" }, 502);
  const rRaw = await rResp.json();
  const rec = rRaw[String(id)] || Object.values(rRaw)[0];
  if (!rec) return json({ error: "找不到採購列" }, 404);
  if ((rec["狀態"] || "") === "入庫完成") return json({ error: "已入帳過,不能重複入庫" }, 409);
  const barcode = String(rec["商品條碼"] || "").trim();
  const prodMap = await getProductMap(env);
  const prod = prodMap[barcode];
  if (!prod) return json({ error: "賣場商品找不到條碼 " + barcode }, 404);
  const newStock = (prod.stock || 0) + bought;
  const sf = new URLSearchParams();
  sf.set(FIELD.庫存, String(newStock));
  const sResp = await fetch(ragicUrl(env, `${PRODUCT_SHEET}/${prod.rid}`, "api&v=3"), {
    method: "POST",
    headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
    body: sf.toString(),
  });
  if (!sResp.ok) return json({ error: "庫存寫入失敗" }, 502);
  const f = new URLSearchParams();
  f.set(PURCHASE_FIELD.已購數量, String(bought));
  f.set(PURCHASE_FIELD.狀態, "入庫完成");
  await fetch(ragicUrl(env, `${PURCHASE_SHEET}/${encodeURIComponent(id)}`, "api&v=3"), {
    method: "POST",
    headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
    body: f.toString(),
  });
  return json({ ok: true, newStock });
}

// GET /store/api/admin/waiting — 待配單（已送出,FIFO 排序）＋品項明細＋現時庫存
async function adminGetWaiting(env, request, url) {
  if (!adminAuthorized(env, request, url)) return json({ error: "unauthorized" }, 401);
  const listUrl = ragicUrl(env, ORDER_SHEET, `api&v=3&where=${ORDER_FIELD.訂單狀態},eq,${encodeURIComponent("已送出")}&limit=200`);
  const [resp, prodMap] = await Promise.all([fetch(listUrl, { headers: ragicHeaders(env) }), getProductMap(env)]);
  if (!resp.ok) return json({ error: "Ragic 讀取失敗" }, 502);
  const raw = await resp.json();
  const heads = Object.values(raw)
    .filter((r) => r && typeof r === "object" && r._ragicId !== undefined)
    .sort((a, b) => a._ragicId - b._ragicId);
  const orders = [];
  for (const h of heads) {
    const oResp = await fetch(ragicUrl(env, `${ORDER_SHEET}/${h._ragicId}`, "api&v=3"), { headers: ragicHeaders(env) });
    if (!oResp.ok) continue;
    const oRaw = await oResp.json();
    const rec = oRaw[String(h._ragicId)] || Object.values(oRaw)[0];
    const sub = (rec && rec[ORDER_SUBTABLE_KEY]) || {};
    const lines = Object.values(sub)
      .filter((l) => l && l["商品條碼"])
      .map((l) => ({
        barcode: String(l["商品條碼"]).trim(),
        name: l["中文名稱"] || l["日文名稱"] || "",
        qty: Number(String(l["數量"] || "0").replace(/[^0-9.]/g, "")) || 0,
      }));
    orders.push({
      id: h._ragicId,
      no: h["訂單編號"] || "",
      customer: h["客戶名稱"] || "",
      date: String(h._create_date || "").split(" ")[0],
      lines,
    });
  }
  const stocks = {};
  for (const bc in prodMap) stocks[bc] = prodMap[bc].stock || 0;
  return json({ orders, stocks });
}

// POST /store/api/admin/assign {ids:[訂單ragicId…]} — 對勾選訂單依序配單（整單庫存夠才配）
async function adminAssign(env, request, url) {
  if (!adminAuthorized(env, request, url)) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid body" }, 400); }
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return json({ error: "沒有勾選訂單" }, 400);
  const prodMap = await getProductMap(env);
  const stocks = {};
  for (const bc in prodMap) stocks[bc] = prodMap[bc].stock || 0;
  const results = [];
  for (const id of ids.slice(0, 30)) {
    const oResp = await fetch(ragicUrl(env, `${ORDER_SHEET}/${encodeURIComponent(id)}`, "api&v=3"), { headers: ragicHeaders(env) });
    if (!oResp.ok) { results.push({ id, result: "讀取失敗" }); continue; }
    const oRaw = await oResp.json();
    const rec = oRaw[String(id)] || Object.values(oRaw)[0];
    if (!rec || (rec["訂單狀態"] || "") !== "已送出") { results.push({ id, no: rec && rec["訂單編號"], result: "非待配狀態,略過" }); continue; }
    const lines = Object.values(rec[ORDER_SUBTABLE_KEY] || {})
      .filter((l) => l && l["商品條碼"])
      .map((l) => ({ barcode: String(l["商品條碼"]).trim(), qty: Number(String(l["數量"] || "0").replace(/[^0-9.]/g, "")) || 0 }));
    const ok = lines.length && lines.every((l) => (stocks[l.barcode] ?? -1) >= l.qty);
    if (!ok) { results.push({ id, no: rec["訂單編號"], result: "庫存不足,略過" }); continue; }
    for (const l of lines) {
      stocks[l.barcode] -= l.qty;
      const sf = new URLSearchParams();
      sf.set(FIELD.庫存, String(stocks[l.barcode]));
      await fetch(ragicUrl(env, `${PRODUCT_SHEET}/${prodMap[l.barcode].rid}`, "api&v=3"), {
        method: "POST",
        headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
        body: sf.toString(),
      });
    }
    const uf = new URLSearchParams();
    uf.set(ORDER_FIELD.訂單狀態, "已配單");
    await fetch(ragicUrl(env, `${ORDER_SHEET}/${encodeURIComponent(id)}`, "api&v=3"), {
      method: "POST",
      headers: { ...ragicHeaders(env), "content-type": "application/x-www-form-urlencoded" },
      body: uf.toString(),
    });
    results.push({ id, no: rec["訂單編號"], result: "已配單" });
  }
  return json({ ok: true, results });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === "/store/admin") {
      // 後台頁（頁面本身公開、資料靠通行碼）
      return env.ASSETS.fetch(new Request(new URL("/store-admin", url.origin), request));
    }
    if (p === "/store/api/admin/purchases" && request.method === "GET") {
      return adminGetPurchases(env, request, url);
    }
    if (p === "/store/api/admin/arrive" && request.method === "POST") {
      return adminPurchaseArrive(env, request, url);
    }
    if (p === "/store/api/admin/plan" && request.method === "POST") {
      return adminPurchasePlan(env, request, url);
    }
    if (p === "/store/api/admin/unarrive" && request.method === "POST") {
      return adminPurchaseUnarrive(env, request, url);
    }
    if (p === "/store/api/admin/bought" && request.method === "POST") {
      return adminPurchaseBought(env, request, url);
    }
    if (p === "/store/api/admin/waiting" && request.method === "GET") {
      return adminGetWaiting(env, request, url);
    }
    if (p === "/store/api/admin/assign" && request.method === "POST") {
      return adminAssign(env, request, url);
    }
    if (p === "/store/api/products" && request.method === "GET") {
      return getProducts(env);
    }
    if (p === "/store/api/me" && request.method === "GET") {
      return getMe(env, url);
    }
    if (p === "/store/api/checkout" && request.method === "POST") {
      return checkout(env, request);
    }
    if (p === "/store/api/orders" && request.method === "GET") {
      return getMyOrders(env, url);
    }
    if (p === "/store/api/orderitems" && request.method === "GET") {
      return getOrderItems(env, url);
    }
    if (p === "/store/api/img" && request.method === "GET") {
      return getImage(env, url);
    }
    if (p === "/store/api/order" && request.method === "POST") {
      return createOrder(env, request);
    }
    // 其餘一律交給靜態資產（官網原頁面 + /store.html）
    return env.ASSETS.fetch(request);
  },
};
