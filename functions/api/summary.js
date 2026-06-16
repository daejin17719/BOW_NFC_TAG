const TOKEN_CACHE_SECONDS = 3000;
const DASHBOARD_COOKIE_NAME = "dashboard_auth";
const DASHBOARD_COOKIE_MAX_AGE = 60 * 60 * 8;

export async function onRequestGet({ env, request }) {
  try {
    const auth = await requireDashboardAuth(env, request);

    if (!auth.ok) {
      return json(auth.data, auth.status);
    }

    const data = await buildSummary(env);
    return json(data);
  } catch (error) {
    return json(
      {
        error: "summary_failed",
        message: error.message
      },
      500
    );
  }
}

export async function onRequestPost({ env, request }) {
  try {
    const body = await request.json().catch(() => null);

    if (!body) {
      return json(
        {
          error: "invalid_body",
          message: "요청 본문이 필요합니다."
        },
        400
      );
    }

    if (body.action === "dashboardLogin") {
      return await handleDashboardLogin(env, body);
    }

    if (body.action === "dashboardLogout") {
      return json(
        {
          ok: true,
          message: "로그아웃되었습니다."
        },
        200,
        {
          "Set-Cookie": `${DASHBOARD_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`
        }
      );
    }

    const auth = await requireDashboardAuth(env, request);

    if (!auth.ok) {
      return json(auth.data, auth.status);
    }

    if (Array.isArray(body.categories) && !body.action) {
      await updateArrowCategories(env, body.categories);
      const data = await buildSummary(env);

      return json({
        ...data,
        message: "화살 현황이 저장되었습니다."
      });
    }

    if (body.action === "saveArrowCategories") {
      if (!Array.isArray(body.categories)) {
        return json(
          {
            error: "invalid_body",
            message: "categories 배열이 필요합니다."
          },
          400
        );
      }

      await updateArrowCategories(env, body.categories);
      const data = await buildSummary(env);

      return json({
        ...data,
        message: "화살 현황이 저장되었습니다."
      });
    }

    if (body.action === "completeRepair") {
      const serial = clean(body.serial);

      if (!serial) {
        return json(
          {
            error: "invalid_body",
            message: "일련번호가 필요합니다."
          },
          400
        );
      }

      await completeBowRepair(env, serial);
      const data = await buildSummary(env);

      return json({
        ...data,
        message: `${serial}번 활이 수리 완료 처리되었습니다.`
      });
    }

    if (body.action === "completeReturn") {
      const serial = clean(body.serial);

      if (!serial) {
        return json(
          {
            error: "invalid_body",
            message: "일련번호가 필요합니다."
          },
          400
        );
      }

      await completeBowReturn(env, serial);
      const data = await buildSummary(env);

      return json({
        ...data,
        message: `${serial}번 활이 반납 완료 처리되었습니다.`
      });
    }

    if (body.action === "addMemo") {
      const text = clean(body.text);

      if (!text) {
        return json(
          {
            error: "invalid_body",
            message: "메모 내용이 필요합니다."
          },
          400
        );
      }

      await addMemo(env, text);
      const data = await buildSummary(env);

      return json({
        ...data,
        message: "메모가 추가되었습니다."
      });
    }

    if (body.action === "deleteMemo") {
      const index = Number(body.index);

      if (!Number.isInteger(index) || index < 0) {
        return json(
          {
            error: "invalid_body",
            message: "삭제할 메모 번호가 올바르지 않습니다."
          },
          400
        );
      }

      await deleteMemo(env, index);
      const data = await buildSummary(env);

      return json({
        ...data,
        message: "메모가 삭제되었습니다."
      });
    }

    return json(
      {
        error: "unknown_action",
        message: "지원하지 않는 작업입니다."
      },
      400
    );
  } catch (error) {
    return json(
      {
        error: "save_failed",
        message: error.message
      },
      500
    );
  }
}

async function handleDashboardLogin(env, body) {
  const expectedPassword = clean(env.ADMIN_PASSWORD);
  const inputPassword = clean(body.password);

  if (!expectedPassword) {
    return json(
      {
        error: "admin_password_not_set",
        message: "ADMIN_PASSWORD가 Cloudflare 환경변수에 설정되지 않았습니다."
      },
      500
    );
  }

  if (!inputPassword || inputPassword !== expectedPassword) {
    return json(
      {
        error: "unauthorized",
        message: "비밀번호가 올바르지 않습니다."
      },
      401
    );
  }

  const token = await createDashboardToken(env);

  return json(
    {
      ok: true,
      message: "인증되었습니다."
    },
    200,
    {
      "Set-Cookie": `${DASHBOARD_COOKIE_NAME}=${token}; Path=/; Max-Age=${DASHBOARD_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax; Secure`
    }
  );
}

async function requireDashboardAuth(env, request) {
  const expectedPassword = clean(env.ADMIN_PASSWORD);

  if (!expectedPassword) {
    return {
      ok: false,
      status: 500,
      data: {
        error: "admin_password_not_set",
        message: "ADMIN_PASSWORD가 Cloudflare 환경변수에 설정되지 않았습니다."
      }
    };
  }

  const cookieToken = getCookie(request, DASHBOARD_COOKIE_NAME);
  const expectedToken = await createDashboardToken(env);

  if (!cookieToken || cookieToken !== expectedToken) {
    return {
      ok: false,
      status: 401,
      data: {
        error: "unauthorized",
        message: "대시보드 인증이 필요합니다."
      }
    };
  }

  return {
    ok: true
  };
}

async function createDashboardToken(env) {
  const password = clean(env.ADMIN_PASSWORD);
  const text = `dashboard:${password}`;

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );

  return arrayBufferToBase64Url(digest);
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const [rawKey, ...rawValueParts] = cookie.trim().split("=");

    if (rawKey === name) {
      return rawValueParts.join("=");
    }
  }

  return "";
}

async function buildSummary(env) {
  const spreadsheetId = env.SPREADSHEET_ID;
  const sheetName = env.BOW_SHEET_NAME || "장비";
  const startRow = Number(env.BOW_DATA_START_ROW || 28);

  if (!spreadsheetId) {
    throw new Error("SPREADSHEET_ID가 설정되지 않았습니다.");
  }

  const accessToken = await getAccessToken(env);

  const bowRange = `${sheetName}!A${startRow}:H`;
  const bowValues = await readSheetValues(spreadsheetId, bowRange, accessToken);

  const bows = bowValues
    .map((row, index) => normalizeBow(row, startRow + index))
    .filter((item) => item.serial);

  const summary = createSummary(bows);

  const repairBows = bows
    .filter((item) => item.status === "수리 필요")
    .sort(sortBySerial);

  const borrowedBows = bows
    .filter((item) => item.borrowedBy)
    .sort(sortBySerial);

  const topBowValueRange = `${sheetName}!L46`;
  const topBowValueRows = await readSheetValues(spreadsheetId, topBowValueRange, accessToken);
  const topBowValue = clean(topBowValueRows?.[0]?.[0]) || String(summary.total || 0);

  const arrowCategoryRange = `${sheetName}!J28:K33`;
  const arrowCategoryValues = await readSheetValues(
    spreadsheetId,
    arrowCategoryRange,
    accessToken
  );

  const arrowSummary = normalizeArrowSummary(arrowCategoryValues);

  const arrowBadgeRange = `${sheetName}!K69:K70`;
  const arrowBadgeValues = await readSheetValues(
    spreadsheetId,
    arrowBadgeRange,
    accessToken
  );

  const arrowBadges = {
    under65: toNumber(arrowBadgeValues?.[0]?.[0]),
    over7: toNumber(arrowBadgeValues?.[1]?.[0])
  };

  const memos = await readMemos(env, accessToken);

  return {
    summary: {
      ...summary,
      topBowValue
    },
    bows,
    repairBows,
    borrowedBows,
    memos,
    arrowSummary: {
      ...arrowSummary,
      badges: arrowBadges
    },
    updatedAt: new Date().toISOString()
  };
}

async function updateArrowCategories(env, postedCategories) {
  const spreadsheetId = env.SPREADSHEET_ID;
  const sheetName = env.BOW_SHEET_NAME || "장비";

  if (!spreadsheetId) {
    throw new Error("SPREADSHEET_ID가 설정되지 않았습니다.");
  }

  const accessToken = await getAccessToken(env);

  const labelRange = `${sheetName}!J28:J33`;
  const labelValues = await readSheetValues(spreadsheetId, labelRange, accessToken);

  const sheetLabels = labelValues
    .map((row) => clean(row[0]))
    .filter(Boolean);

  if (!sheetLabels.length) {
    throw new Error("화살 분류 라벨을 찾지 못했습니다. J28:J33 범위를 확인하세요.");
  }

  const postedMap = new Map();

  for (const item of postedCategories) {
    const label = clean(item.label);
    const quantity = Math.max(toNumber(item.quantity), 0);

    if (label) {
      postedMap.set(label, quantity);
    }
  }

  const recalculatedMap = recalculateArrowTotal(sheetLabels, postedMap);

  const values = sheetLabels.map((label) => {
    const quantity = recalculatedMap.has(label) ? recalculatedMap.get(label) : 0;
    return [quantity];
  });

  const quantityRange = `${sheetName}!K28:K${27 + values.length}`;
  await writeSheetValues(spreadsheetId, quantityRange, values, accessToken);
}

async function completeBowRepair(env, serial) {
  const bow = await findBowBySerial(env, serial);

  if (!bow) {
    throw new Error(`${serial}번 활을 찾지 못했습니다.`);
  }

  const spreadsheetId = env.SPREADSHEET_ID;
  const sheetName = env.BOW_SHEET_NAME || "장비";
  const accessToken = await getAccessToken(env);
  const date = formatKstDate(new Date());

  await writeSheetValues(
    spreadsheetId,
    `${sheetName}!E${bow.rowNumber}:G${bow.rowNumber}`,
    [["정상", bow.etc || "", date]],
    accessToken
  );
}

async function completeBowReturn(env, serial) {
  const bow = await findBowBySerial(env, serial);

  if (!bow) {
    throw new Error(`${serial}번 활을 찾지 못했습니다.`);
  }

  const spreadsheetId = env.SPREADSHEET_ID;
  const sheetName = env.BOW_SHEET_NAME || "장비";
  const accessToken = await getAccessToken(env);

  await writeSheetValues(
    spreadsheetId,
    `${sheetName}!H${bow.rowNumber}`,
    [[""]],
    accessToken
  );
}

async function findBowBySerial(env, serial) {
  const spreadsheetId = env.SPREADSHEET_ID;
  const sheetName = env.BOW_SHEET_NAME || "장비";
  const startRow = Number(env.BOW_DATA_START_ROW || 28);

  if (!spreadsheetId) {
    throw new Error("SPREADSHEET_ID가 설정되지 않았습니다.");
  }

  const accessToken = await getAccessToken(env);
  const bowRange = `${sheetName}!A${startRow}:H`;
  const bowValues = await readSheetValues(spreadsheetId, bowRange, accessToken);

  const target = clean(serial);

  for (let index = 0; index < bowValues.length; index += 1) {
    const item = normalizeBow(bowValues[index], startRow + index);

    if (item.serial === target) {
      return item;
    }
  }

  return null;
}

async function readMemos(env, accessToken) {
  const spreadsheetId = env.SPREADSHEET_ID;

  if (!spreadsheetId) {
    throw new Error("SPREADSHEET_ID가 설정되지 않았습니다.");
  }

  const config = getMemoConfig(env);
  const rows = await readSheetValues(spreadsheetId, config.range, accessToken);
  const paddedRows = padRows(rows, config.size);

  return paddedRows
    .map((row, index) => ({
      index,
      text: clean(row[0])
    }))
    .filter((item) => item.text);
}

async function addMemo(env, text) {
  const spreadsheetId = env.SPREADSHEET_ID;

  if (!spreadsheetId) {
    throw new Error("SPREADSHEET_ID가 설정되지 않았습니다.");
  }

  const accessToken = await getAccessToken(env);
  const config = getMemoConfig(env);
  const rows = padRows(await readSheetValues(spreadsheetId, config.range, accessToken), config.size);

  const currentTexts = rows.map((row) => clean(row[0]));
  const emptyIndex = currentTexts.findIndex((value) => !value);

  if (emptyIndex === -1) {
    throw new Error(`메모 공간이 가득 찼습니다. ${config.range} 범위를 늘려주세요.`);
  }

  currentTexts[emptyIndex] = text;

  const values = currentTexts.map((value) => [value]);
  await writeSheetValues(spreadsheetId, config.range, values, accessToken);
}

async function deleteMemo(env, index) {
  const spreadsheetId = env.SPREADSHEET_ID;

  if (!spreadsheetId) {
    throw new Error("SPREADSHEET_ID가 설정되지 않았습니다.");
  }

  const accessToken = await getAccessToken(env);
  const config = getMemoConfig(env);
  const rows = padRows(await readSheetValues(spreadsheetId, config.range, accessToken), config.size);

  if (index >= rows.length) {
    throw new Error("삭제할 메모를 찾지 못했습니다.");
  }

  const texts = rows
    .map((row, rowIndex) => rowIndex === index ? "" : clean(row[0]))
    .filter(Boolean);

  while (texts.length < config.size) {
    texts.push("");
  }

  const values = texts.map((value) => [value]);
  await writeSheetValues(spreadsheetId, config.range, values, accessToken);
}

function getMemoConfig(env) {
  const sheetName = env.BOW_SHEET_NAME || "장비";
  const column = env.MEMO_COLUMN || "N";
  const startRow = Number(env.MEMO_START_ROW || 41);
  const endRow = Number(env.MEMO_END_ROW || 50);
  const size = Math.max(endRow - startRow + 1, 1);

  return {
    sheetName,
    column,
    startRow,
    endRow,
    size,
    range: `${sheetName}!${column}${startRow}:${column}${endRow}`
  };
}

function padRows(rows, size) {
  const result = Array.isArray(rows) ? [...rows] : [];

  while (result.length < size) {
    result.push([""]);
  }

  return result.slice(0, size);
}

function recalculateArrowTotal(sheetLabels, postedMap) {
  const result = new Map(postedMap);
  let total = 0;

  for (const label of sheetLabels) {
    if (label === "총량") continue;
    if (label === "수리 필요") continue;

    total += Math.max(toNumber(result.get(label)), 0);
  }

  if (sheetLabels.includes("총량")) {
    result.set("총량", total);
  }

  return result;
}

function normalizeBow(row, rowNumber = null) {
  return {
    rowNumber,
    serial: clean(row[0]),
    brand: clean(row[1]),
    size: clean(row[2]),
    pound: clean(row[3]),
    status: normalizeStatus(row[4]),
    etc: clean(row[5]),
    check: clean(row[6]),
    borrowedBy: clean(row[7])
  };
}

function normalizeStatus(value) {
  const status = clean(value);

  if (status === "정상") return "정상";
  if (status === "수리 필요") return "수리 필요";
  if (status === "불량") return "불량";
  if (status === "말소") return "말소";

  return status || "기타";
}

function createSummary(items) {
  const summary = {
    total: items.length,
    normal: 0,
    repair: 0,
    bad: 0,
    deleted: 0,
    other: 0
  };

  for (const item of items) {
    if (item.status === "정상") {
      summary.normal += 1;
    } else if (item.status === "수리 필요") {
      summary.repair += 1;
    } else if (item.status === "불량") {
      summary.bad += 1;
    } else if (item.status === "말소") {
      summary.deleted += 1;
    } else {
      summary.other += 1;
    }
  }

  return summary;
}

function normalizeArrowSummary(categoryRows) {
  const categories = (categoryRows || [])
    .map((row) => ({
      label: clean(row[0]),
      quantity: toNumber(row[1])
    }))
    .filter((item) => item.label);

  const repairRow = categories.find((item) => item.label === "수리 필요");
  const totalRow = categories.find((item) => item.label === "총량");

  const calculatedTotal = categories.reduce((sum, item) => {
    if (item.label === "수리 필요") return sum;
    if (item.label === "총량") return sum;
    return sum + item.quantity;
  }, 0);

  const repairNeeded = repairRow ? repairRow.quantity : 0;
  const total = totalRow ? totalRow.quantity : calculatedTotal;

  return {
    total,
    repairNeeded,
    categories
  };
}

function sortBySerial(a, b) {
  const aNum = Number(a.serial);
  const bNum = Number(b.serial);

  if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
    return aNum - bNum;
  }

  return String(a.serial).localeCompare(String(b.serial), "ko", {
    numeric: true
  });
}

function formatKstDate(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

async function readSheetValues(spreadsheetId, range, accessToken) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error?.message || `${range} 값을 읽지 못했습니다.`);
  }

  return data.values || [];
}

async function writeSheetValues(spreadsheetId, range, values, accessToken) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      values
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error?.message || `${range} 값을 저장하지 못했습니다.`);
  }

  return data;
}

async function getAccessToken(env) {
  const cached = await getCachedToken(env);
  if (cached) return cached;

  const clientEmail = env.GOOGLE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(env.GOOGLE_PRIVATE_KEY);

  if (!clientEmail || !privateKey) {
    throw new Error("GOOGLE_CLIENT_EMAIL 또는 GOOGLE_PRIVATE_KEY가 설정되지 않았습니다.");
  }

  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT"
  };

  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const unsignedToken =
    base64UrlEncode(JSON.stringify(header)) +
    "." +
    base64UrlEncode(JSON.stringify(claim));

  const signature = await signJwt(unsignedToken, privateKey);
  const jwt = unsignedToken + "." + signature;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error_description || data?.error || "Google access token 발급 실패");
  }

  await setCachedToken(env, data.access_token);

  return data.access_token;
}

async function getCachedToken(env) {
  if (!caches?.default || !env.GOOGLE_CLIENT_EMAIL) return null;

  const cacheKey = new Request(
    `https://token-cache.local/${encodeURIComponent(env.GOOGLE_CLIENT_EMAIL)}`
  );

  const cached = await caches.default.match(cacheKey);

  if (!cached) return null;

  const data = await cached.json().catch(() => null);
  return data?.access_token || null;
}

async function setCachedToken(env, accessToken) {
  if (!caches?.default || !env.GOOGLE_CLIENT_EMAIL || !accessToken) return;

  const cacheKey = new Request(
    `https://token-cache.local/${encodeURIComponent(env.GOOGLE_CLIENT_EMAIL)}`
  );

  const response = new Response(JSON.stringify({ access_token: accessToken }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `max-age=${TOKEN_CACHE_SECONDS}`
    }
  });

  await caches.default.put(cacheKey, response);
}

async function signJwt(unsignedToken, privateKeyPem) {
  const key = await importPrivateKey(privateKeyPem);

  const signature = await crypto.subtle.sign(
    {
      name: "RSASSA-PKCS1-v1_5"
    },
    key,
    new TextEncoder().encode(unsignedToken)
  );

  return arrayBufferToBase64Url(signature);
}

async function importPrivateKey(privateKeyPem) {
  const pem = privateKeyPem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryDer = base64ToArrayBuffer(pem);

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );
}

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n");
}

function clean(value) {
  return String(value ?? "").trim();
}

function toNumber(value) {
  const number = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(value);
  return arrayBufferToBase64Url(bytes);
}

function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}
