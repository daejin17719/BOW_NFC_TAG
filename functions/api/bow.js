const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const id = url.searchParams.get("id") || url.searchParams.get("c") || url.searchParams.get("code");

    if (!id) {
      return jsonResponse({ error: "조회 코드가 없습니다." }, 400);
    }

    const env = context.env;
    const item = await getBowById(env, id);

    if (!item) {
      return jsonResponse({ error: "A열에서 해당 값을 찾을 수 없습니다.", id }, 404);
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
    const env = context.env;
    const body = await context.request.json();

    const id = body.id || body.serial || body.c || body.code;
    const status = body.status || "";
    const check = body.check || "";

    if (!id) {
      return jsonResponse({ error: "조회 코드가 없습니다." }, 400);
    }

    const result = await updateBowData(env, id, status, check);
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

async function getBowById(env, id) {
  const sheetName = env.SHEET_NAME;
  const startRow = Number(env.DATA_START_ROW || 2);

  const accessToken = await getAccessToken(env);

  const range = `'${sheetName}'!A${startRow}:G`;
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
  const target = normalizeKey(id);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (normalizeKey(row[0]) === target) {
      return {
        rowNumber: startRow + i,
        serial: row[0] || "",
        brand: row[1] || "",
        size: row[2] || "",
        pound: row[3] || "",
        status: row[4] || "",
        etc: row[5] || "",
        check: row[6] || "",
      };
    }
  }

  return null;
}

async function updateBowData(env, id, status, check) {
  const item = await getBowById(env, id);

  if (!item) {
    throw new Error("A열에서 해당 값을 찾을 수 없습니다.");
  }

  const sheetName = env.SHEET_NAME;
  const rowNumber = item.rowNumber;
  const accessToken = await getAccessToken(env);

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values:batchUpdate`;

  const body = {
    valueInputOption: "USER_ENTERED",
    data: [
      {
        range: `'${sheetName}'!E${rowNumber}`,
        values: [[status]],
      },
      {
        range: `'${sheetName}'!G${rowNumber}`,
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

  const now = new Date();

  return {
    message: "저장 완료",
    updatedAt: formatDateTime(now),
    rowNumber,
    serial: item.serial,
    status,
    check,
  };
}

async function getAccessToken(env) {
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
