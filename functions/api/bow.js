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

    const status = body.status || "";
    const check = body.check || "";

    if (!key) {
      return jsonResponse({ error: "조회 코드가 없습니다." }, 400);
    }

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
  };
}

async function getItemByKey(env, mode, key) {
  const config = getConfig(env, mode);
  const accessToken = await getAccessToken(env);

  const rowNumber = await findRowNumberByColumnA(
    env,
    accessToken,
    config,
    key
  );

  if (rowNumber === -1) {
    return null;
  }

  const row = await readRowAtoG(
    env,
    accessToken,
    config.sheetName,
    rowNumber
  );

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
  };
}

/*
속도 개선:
A:G 전체를 한 번에 읽지 않고,
A열만 먼저 읽어서 행 번호를 찾는다.
*/
async function findRowNumberByColumnA(env, accessToken, config, key) {
  const range = `'${config.sheetName}'!A${config.startRow}:A`;

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
    throw new Error(`Sheets A열 읽기 실패: ${response.status} ${text}`);
  }

  const data = await response.json();
  const rows = data.values || [];
  const target = normalizeKey(key);

  for (let i = 0; i < rows.length; i++) {
    if (normalizeKey(rows[i][0]) === target) {
      return config.startRow + i;
    }
  }

  return -1;
}

/*
A열에서 찾은 행만 A:G로 읽는다.
*/
async function readRowAtoG(env, accessToken, sheetName, rowNumber) {
  const range = `'${sheetName}'!A${rowNumber}:G${rowNumber}`;

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
    throw new Error(`Sheets 행 읽기 실패: ${response.status} ${text}`);
  }

  const data = await response.json();
  return (data.values && data.values[0]) || [];
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

  const body = {
    valueInputOption: "USER_ENTERED",
    data: [
      {
        range: `'${config.sheetName}'!${columnToLetter(config.statusColumn)}${rowNumber}`,
        values: [[status]],
      },
      {
        range: `'${config.sheetName}'!${columnToLetter(config.checkColumn)}${rowNumber}`,
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

  return {
    message: "저장 완료",
    updatedAt: formatDateTime(new Date()),
    mode: config.mode,
    rowNumber,
    key,
    status,
    check,
  };
}

/*
Google access token 캐시:
- Cloudflare Cache API에 60분 저장
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
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
