export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");

  return Response.json({
    ok: true,
    message: "Cloudflare API 연결 성공",
    id: id || null
  });
}
