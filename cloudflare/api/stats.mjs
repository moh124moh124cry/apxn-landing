
export async function handleStats(request, env) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  };

  function json(data, status = 200) {
    return new Response(
      JSON.stringify(data),
      {
        status,
        headers
      }
    );
  }

  const supabaseUrl = env.SUPABASE_URL;
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    return json(
      {
        error: "Missing environment variables"
      },
      500
    );
  }

  try {
    const apiUrl =
      supabaseUrl.replace(/\/+$/, "") +
      "/rest/v1/visits?select=country";

    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        apikey: supabaseSecretKey,
        Authorization:
          `Bearer ${supabaseSecretKey}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      return json(
        {
          error: "Unable to load statistics"
        },
        500
      );
    }

    const data = await response.json();

    return json(data);
  } catch {
    return json(
      {
        error: "Unable to load statistics"
      },
      500
    );
  }
}
