const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_CACHE_SECONDS = 3000;

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);

    const mode = getMode(url.searchParams);
    const key =
      url.searchParams.get("id") ||
      url.searchParams.get("c") ||
      url.searchParams.get("code") ||
      url.searchParams.get("serial");

    if (!key) {
      return jsonResponse({ error: "조회 코드가 없습니다." }, 400);
    }

    const item = await getItemByKey(context.env, mode, key);

    if (!item) {
      return jsonResponse(
        {
          error: "A열에서 해당 값을 찾을 수 없습니다.",
          mode,
          key,
        },
        404
      );
    }

    return jsonResponse(item);
  } catch (error) {
    return jsonResponse(
      {
        error: "server_error",
        message: error.message,
      },
      500
    );
  }
}

export async function onRequestPost(context) {
  try {
    const url = new URL(context.request.url);
    const body = await context.request.json();

    const mode = body.t || body.type || body.mode || getMode(url.searchParams);

    const key =
      body.id ||
      body.c ||
      body.code ||
      body.serial;

    if (!key) {
      return jsonResponse({ error: "조회 코드가 없습니다." }, 400);
    }

    if (body.action === "saveBorrowedBy") {
      const result = await saveBorrowedBy(context.env, key, body.borrowedBy);
      return jsonResponse(result);
    }

    const status = body.status || "";
    const check = body.check || "";

    const result = await updateItemData(context.env, mode, key, status, check);
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse(
      {
        error: "server_error",
        message: error.message,
      },
      500
    );
  }
}

/*
mode:
- bow / b / 기본값: 활 장부
- personal / p / item: 개인 장비
*/
function getMode(searchParams) {
  const raw =
    searchParams.get("t") ||
    searchParams.get("type") ||
    searchParams.get("mode") ||
    "bow";

  const mode = String(raw || "").trim().toLowerCase();

  if (
    mode === "p" ||
    mode === "personal" ||
    mode === "item" ||
    mode === "private"
  ) {
    return "personal";
  }

  return "bow";
}

function getConfig(env, mode) {
  if (mode === "personal") {
    return {
      mode: "personal",
      sheetName:
        env.PERSONAL_SHEET_NAME ||
        env.ITEM_SHEET_NAME ||
        "개인 장비",
      startRow: Number(
        env.PERSONAL_DATA_START_ROW ||
        env.ITEM_DATA_START_ROW ||
        2
      ),
      statusColumn: 6,
      checkColumn: 7,
      readEndColumn: "G",
    };
  }

  return {
    mode: "bow",
    sheetName:
      env.BOW_SHEET_NAME ||
      env.SHEET_NAME ||
      "장비",
    startRow: Number(
      env.BOW_DATA_START_ROW ||
      env.DATA_START_ROW ||
      28
    ),
    statusColumn: 5,
    checkColumn: 7,
    borrowColumn: 8,
    readEndColumn: "H",
  };
}

/*
공용 활:
A 일련번호
B 브랜드
C 사이즈
D 파운드
E 상태
F 기타
G 점검 내역
H 개인 반출
*/
async function getItemByKey(env, mode, key) {
  const config = getConfig(env, mode);
  const accessToken = await getAccessToken(env);

  const range = `'${config.sheetName}'!A${config.startRow}:${config.readEndColumn}`;

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/` +
    encodeURIComponent(range);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sheets 읽기 실패: ${response.status} ${text}`);
  }

  const data = await response.json();
  const rows = data.values || [];
  const target = normalizeKey(key);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (normalizeKey(row[0]) === target) {
      const rowNumber = config.startRow + i;

      if (config.mode === "personal") {
        return {
          mode: "personal",
          rowNumber,
          code: row[0] || "",
          owner: row[1] || "",
          brand: row[2] || "",
          size: row[3] || "",
          pound: row[4] || "",
          status: row[5] || "",
          check: row[6] || "",
        };
      }

      return {
        mode: "bow",
        rowNumber,
        serial: row[0] || "",
        brand: row[1] || "",
        size: row[2] || "",
        pound: row[3] || "",
        status: row[4] || "",
        etc: row[5] || "",
        check: row[6] || "",
        borrowedBy: row[7] || "",
      };
    }
  }

  return null;
}

async function updateItemData(env, mode, key, status, check) {
  const config = getConfig(env, mode);
  const item = await getItemByKey(env, config.mode, key);

  if (!item) {
    throw new Error("A열에서 해당 값을 찾을 수 없습니다.");
  }

  const accessToken = await getAccessToken(env);
  const rowNumber = item.rowNumber;

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values:batchUpdate`;

  const statusCell = `${columnToLetter(config.statusColumn)}${rowNumber}`;
  const checkCell = `${columnToLetter(config.checkColumn)}${rowNumber}`;

  const body = {
    valueInputOption: "USER_ENTERED",
    data: [
      {
        range: sheetRange(config.sheetName, statusCell),
        values: [[status]],
      },
      {
        range: sheetRange(config.sheetName, checkCell),
        values: [[check]],
      },
    ],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sheets 저장 실패: ${response.status} ${text}`);
  }

  let logWarning = "";

  if (config.mode === "bow") {
    try {
      await recordEquipmentLog(env, accessToken, statusCell);
    } catch (error) {
      logWarning = `로그 기록 실패: ${error.message}`;
      console.warn(logWarning);
    }
  }

  return {
    message: "저장 완료",
    updatedAt: formatDateTime(new Date()),
    mode: config.mode,
    rowNumber,
    key,
    status,
    check,
    logWarning,
  };
}

async function saveBorrowedBy(env, key, borrowedByValue) {
  const config = getConfig(env, "bow");
  const borrowedBy = clean(borrowedByValue);

  if (!borrowedBy) {
    throw new Error("반출자 이름이 필요합니다.");
  }

  const item = await getItemByKey(env, "bow", key);

  if (!item) {
    throw new Error("A열에서 해당 값을 찾을 수 없습니다.");
  }

  if (item.borrowedBy) {
    return jsonConflictError("이미 반출자가 등록되어 있어 수정할 수 없습니다.");
  }

  const accessToken = await getAccessToken(env);
  const rowNumber = item.rowNumber;
  const borrowCell = `${columnToLetter(config.borrowColumn)}${rowNumber}`;

  const range = sheetRange(config.sheetName, borrowCell);

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/` +
    encodeURIComponent(range) +
    "?valueInputOption=USER_ENTERED";

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      values: [[borrowedBy]],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`반출자 저장 실패: ${response.status} ${text}`);
  }

  let logWarning = "";

  try {
    await recordEquipmentLog(env, accessToken, borrowCell);
  } catch (error) {
    logWarning = `로그 기록 실패: ${error.message}`;
    console.warn(logWarning);
  }

  return {
    message: "개인 반출이 등록되었습니다.",
    updatedAt: formatDateTime(new Date()),
    mode: "bow",
    rowNumber,
    key,
    borrowedBy,
    logWarning,
  };
}

async function recordEquipmentLog(env, accessToken, changedLocation) {
  const spreadsheetId = env.SPREADSHEET_ID;
  const sheetName = env.BOW_SHEET_NAME || env.SHEET_NAME || "장비";
  const logSheetName = env.LOG_SHEET_NAME || "로그";

  if (!spreadsheetId) {
    throw new Error("SPREADSHEET_ID가 설정되지 않았습니다.");
  }

  const location = clean(changedLocation);

  if (!location) {
    return;
  }

  await ensureLogSheet(env, accessToken, logSheetName);

  const batchValues = await readSheetValuesBatch(
    spreadsheetId,
    [
      sheetRange(sheetName, "K56"),
      sheetRange(sheetName, "K57"),
      sheetRange(sheetName, "K43"),
      sheetRange(logSheetName, "A:E"),
    ],
    accessToken
  );

  const currentBows = clean(batchValues[0]?.[0]?.[0]);
  const currentArrows = clean(batchValues[1]?.[0]?.[0]);
  const currentRepair = clean(batchValues[2]?.[0]?.[0]);

  const logRows = batchValues[3] || [];
  const lastRowNumber = Math.max(logRows.length, 1);
  const lastRow = logRows.length > 1 ? logRows[logRows.length - 1] : null;

  const lastBows = lastRow ? clean(lastRow[1]) : "";
  const lastArrows = lastRow ? clean(lastRow[2]) : "";
  const lastRepair = lastRow ? clean(lastRow[3]) : "";

  if (
    currentBows === lastBows &&
    currentArrows === lastArrows &&
    currentRepair === lastRepair
  ) {
    return;
  }

  const now = new Date();
  const todayStr = formatKstDate(now);
  let targetRow = lastRowNumber + 1;
  let finalLocation = location;

  if (lastRow) {
    const lastDateStr = extractDateString(lastRow[0]);

    if (todayStr === lastDateStr) {
      targetRow = lastRowNumber;
      finalLocation = mergeLocations(lastRow[4], location);
    }
  }

  await writeSheetValues(
    spreadsheetId,
    sheetRange(logSheetName, `A${targetRow}:E${targetRow}`),
    [[
      formatKstDateTime(now),
      currentBows,
      currentArrows,
      currentRepair,
      finalLocation,
    ]],
    accessToken
  );
}

async function ensureLogSheet(env, accessToken, logSheetName) {
  const spreadsheetId = env.SPREADSHEET_ID;

  const metadataUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    "?fields=sheets.properties.title";

  const metadataResponse = await fetch(metadataUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!metadataResponse.ok) {
    const text = await metadataResponse.text();
    throw new Error(`스프레드시트 정보 확인 실패: ${metadataResponse.status} ${text}`);
  }

  const metadata = await metadataResponse.json();
  const sheets = metadata.sheets || [];
  const exists = sheets.some((sheet) => sheet?.properties?.title === logSheetName);

  if (!exists) {
    const createUrl =
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;

    const createResponse = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title: logSheetName,
              },
            },
          },
        ],
      }),
    });

    if (!createResponse.ok) {
      const text = await createResponse.text();
      throw new Error(`로그 시트 생성 실패: ${createResponse.status} ${text}`);
    }
  }

  const headerRows = await readSheetValues(
    spreadsheetId,
    sheetRange(logSheetName, "A1:E1"),
    accessToken
  );

  const hasHeader = headerRows?.[0]?.some((value) => clean(value));

  if (!hasHeader) {
    await writeSheetValues(
      spreadsheetId,
      sheetRange(logSheetName, "A1:E1"),
      [["기록일시", "가용 활(K56)", "가용 화살(K57)", "수리 대기(K43)", "변경위치"]],
      accessToken
    );
  }
}

async function readSheetValues(spreadsheetId, range, accessToken) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/` +
    encodeURIComponent(range);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error?.message || `${range} 값을 읽지 못했습니다.`);
  }

  return data.values || [];
}

async function readSheetValuesBatch(spreadsheetId, ranges, accessToken) {
  const params = new URLSearchParams();

  for (const range of ranges) {
    params.append("ranges", range);
  }

  params.set("majorDimension", "ROWS");

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values:batchGet?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error?.message || "Google Sheets batchGet 실패");
  }

  return (data.valueRanges || []).map((item) => item.values || []);
}

async function writeSheetValues(spreadsheetId, range, values, accessToken) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/` +
    encodeURIComponent(range) +
    "?valueInputOption=USER_ENTERED";

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      values,
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error?.message || `${range} 값을 저장하지 못했습니다.`);
  }

  return data;
}

function sheetRange(sheetName, a1Notation) {
  return `'${escapeSheetName(sheetName)}'!${a1Notation}`;
}

function escapeSheetName(sheetName) {
  return String(sheetName || "").replace(/'/g, "''");
}

function mergeLocations(oldLocation, newLocation) {
  const locations = String(oldLocation || "")
    .split(",")
    .map((value) => clean(value))
    .filter(Boolean);

  const newLocations = String(newLocation || "")
    .split(",")
    .map((value) => clean(value))
    .filter(Boolean);

  const result = [...locations];

  for (const location of newLocations) {
    if (!result.includes(location)) {
      result.push(location);
    }
  }

  return result.join(", ");
}

function extractDateString(value) {
  const text = clean(value);
  const match = text.match(/\d{4}-\d{2}-\d{2}/);

  if (match) {
    return match[0];
  }

  const date = new Date(text);

  if (!Number.isNaN(date.getTime())) {
    return formatKstDate(date);
  }

  return "";
}

function formatKstDate(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function formatKstDateTime(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);

  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  const ss = String(kst.getUTCSeconds()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/*
Google access token 캐시:
- Cloudflare Cache API에 저장
- 같은 서비스 계정이면 다음 요청부터 토큰 발급 과정을 생략
*/
async function getAccessToken(env) {
  const cacheKey = new Request(
    `https://token-cache.local/google-access-token/${encodeURIComponent(env.GOOGLE_CLIENT_EMAIL)}`
  );

  const cached = await caches.default.match(cacheKey);

  if (cached) {
    const cachedData = await cached.json();

    if (cachedData && cachedData.access_token) {
      return cachedData.access_token;
    }
  }

  const accessToken = await requestNewAccessToken(env);

  const cacheResponse = new Response(
    JSON.stringify({
      access_token: accessToken,
      cachedAt: new Date().toISOString(),
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${TOKEN_CACHE_SECONDS}`,
      },
    }
  );

  await caches.default.put(cacheKey, cacheResponse);

  return accessToken;
}

async function requestNewAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const claim = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };

  const unsignedJwt =
    base64UrlEncode(JSON.stringify(header)) +
    "." +
    base64UrlEncode(JSON.stringify(claim));

  const privateKey = normalizePrivateKey(env.GOOGLE_PRIVATE_KEY);
  const signature = await signJwt(unsignedJwt, privateKey);

  const jwt = unsignedJwt + "." + signature;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google 토큰 발급 실패: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function signJwt(unsignedJwt, privateKeyPem) {
  const keyData = pemToArrayBuffer(privateKeyPem);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedJwt)
  );

  return arrayBufferToBase64Url(signature);
}

function normalizePrivateKey(key) {
  return String(key || "")
    .replace(/\\n/g, "\n")
    .trim();
}

function pemToArrayBuffer(pem) {
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function base64UrlEncode(input) {
  const bytes = new TextEncoder().encode(input);
  return arrayBufferToBase64Url(bytes.buffer);
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

function normalizeKey(value) {
  return String(value || "").trim().toUpperCase();
}

function clean(value) {
  return String(value ?? "").trim();
}

function columnToLetter(columnNumber) {
  let letter = "";
  let number = columnNumber;

  while (number > 0) {
    const mod = (number - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    number = Math.floor((number - mod) / 26);
  }

  return letter;
}

function formatDateTime(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function jsonConflictError(message) {
  return {
    error: "borrow_locked",
    message,
  };
}

function jsonResponse(data, status = 200) {
  const responseStatus = data?.error === "borrow_locked" ? 409 : status;

  return new Response(JSON.stringify(data, null, 2), {
    status: responseStatus,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
