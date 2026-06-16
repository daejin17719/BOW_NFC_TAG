const DASHBOARD_COOKIE_NAME = "dashboard_auth";
const DASHBOARD_COOKIE_MAX_AGE = 60 * 60 * 8;

export async function onRequestGet(context) {
  const { env, request } = context;

  const url = new URL(request.url);

  if (url.searchParams.get("logout") === "1") {
    return new Response(null, {
      status: 303,
      headers: {
        "Location": "/dashboard.html",
        "Set-Cookie": `${DASHBOARD_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`
      }
    });
  }

  const auth = await checkDashboardAuth(env, request);

  if (auth.ok) {
    return context.next();
  }

  return html(loginPage(), 200);
}

export async function onRequestPost(context) {
  const { env, request } = context;

  try {
    const formData = await request.formData();
    const inputPassword = clean(formData.get("password"));
    const expectedPassword = clean(env.ADMIN_PASSWORD);

    if (!expectedPassword) {
      return html(
        loginPage("ADMIN_PASSWORD가 Cloudflare 환경변수에 설정되지 않았습니다."),
        500
      );
    }

    if (!inputPassword || inputPassword !== expectedPassword) {
      return html(
        loginPage("비밀번호가 올바르지 않습니다."),
        401
      );
    }

    const token = await createDashboardToken(env);

    return new Response(null, {
      status: 303,
      headers: {
        "Location": "/dashboard.html",
        "Set-Cookie": `${DASHBOARD_COOKIE_NAME}=${token}; Path=/; Max-Age=${DASHBOARD_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax; Secure`
      }
    });
  } catch (error) {
    return html(
      loginPage("로그인 처리 중 오류가 발생했습니다."),
      500
    );
  }
}

async function checkDashboardAuth(env, request) {
  const expectedPassword = clean(env.ADMIN_PASSWORD);

  if (!expectedPassword) {
    return {
      ok: false
    };
  }

  const cookieToken = getCookie(request, DASHBOARD_COOKIE_NAME);
  const expectedToken = await createDashboardToken(env);

  if (!cookieToken || cookieToken !== expectedToken) {
    return {
      ok: false
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

function loginPage(errorMessage = "") {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>공용 장비 현황 로그인</title>

  <style>
    :root {
      --bg: #f6f7f9;
      --text: #0f172a;
      --muted: #64748b;
      --card: #ffffff;
      --primary: #0f172a;
      --error: #991b1b;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100dvh;
      padding: 20px;
      background:
        radial-gradient(circle at top left, #e0f2fe 0, transparent 35%),
        var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .loginBox {
      width: 100%;
      max-width: 360px;
      background: var(--card);
      border-radius: 26px;
      padding: 24px;
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.18);
    }

    .logoWrap {
      display: flex;
      justify-content: center;
      margin-bottom: 18px;
    }

    .logo {
      width: 92px;
      height: auto;
      opacity: 0.82;
      filter: brightness(0);
    }

    .title {
      font-size: 23px;
      line-height: 1.15;
      font-weight: 950;
      letter-spacing: -0.045em;
      text-align: center;
      margin-bottom: 7px;
    }

    .text {
      font-size: 14px;
      font-weight: 850;
      color: var(--muted);
      text-align: center;
      line-height: 1.45;
      margin-bottom: 18px;
    }

    .passwordInput {
      width: 100%;
      border: 1px solid #d1d5db;
      border-radius: 18px;
      padding: 16px;
      font-size: 24px;
      font-weight: 950;
      letter-spacing: 0.08em;
      outline: none;
      text-align: center;
      color: var(--text);
      background: #ffffff;
    }

    .passwordInput:focus {
      border-color: #94a3b8;
      box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.20);
    }

    .submitBtn {
      width: 100%;
      margin-top: 14px;
      border: 0;
      border-radius: 18px;
      padding: 15px;
      font-size: 17px;
      font-weight: 950;
      cursor: pointer;
      background: var(--primary);
      color: white;
    }

    .error {
      min-height: 22px;
      margin-top: 12px;
      font-size: 14px;
      font-weight: 850;
      color: var(--error);
      text-align: center;
      line-height: 1.45;
    }

    .hint {
      margin-top: 18px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      line-height: 1.45;
      text-align: center;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b1020;
        --text: #f8fafc;
        --muted: #94a3b8;
        --card: #111827;
        --primary: #334155;
        --error: #fca5a5;
      }

      .loginBox {
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.32);
      }

      .logo {
        filter: brightness(0) invert(1);
        opacity: 0.86;
      }

      .passwordInput {
        background: #172033;
        border: none;
        color: #f8fafc;
      }

      .passwordInput:focus {
        box-shadow: 0 0 0 2px rgba(148, 163, 184, 0.16);
      }
    }
  </style>
</head>

<body>
  <main class="loginBox">
    <div class="logoWrap">
      <img class="logo" src="/logo.png" alt="서울대학교 국궁부">
    </div>

    <div class="title">공용 장비 현황</div>
    <div class="text">관리자 비밀번호를 입력하세요.</div>

    <form method="POST" action="/dashboard.html">
      <input
        class="passwordInput"
        name="password"
        type="password"
        inputmode="numeric"
        pattern="[0-9]*"
        autocomplete="off"
        placeholder="비밀번호"
        autofocus
      >

      <button class="submitBtn" type="submit">
        확인
      </button>
    </form>

    <div class="error">${escapeHtml(errorMessage)}</div>

    <div class="hint">
      서울대학교 국궁부 공용 장비 관리 체계
    </div>
  </main>
</body>
</html>`;
}

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function clean(value) {
  return String(value ?? "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
